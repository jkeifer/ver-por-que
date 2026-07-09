/**
 * Query simulation panel: a row-groups × columns matrix of what a query would
 * read (and why), a structured read summary, and the builder cards beneath it.
 *
 * Rendering and input handling only — the pruning engine lives in
 * business/pruning. The delegate owns everything outside the panel (segment
 * dimming, info-panel overlay, permalink). The simulation is LIVE: every
 * change that yields a valid query state re-evaluates (value edits behind a
 * short debounce). An incomplete predicate row — empty or unparseable value —
 * is simply excluded from evaluation and flagged with a muted hint; it never
 * errors and never blocks the other rows.
 */
import {
    columnStats,
    formatStatValue,
    isValidPredicate,
    leafColumns,
    OP_LABEL,
    type BloomResults,
    type Op,
    type Predicate,
    type QueryState,
} from '../business/pruning';
import {
    resolve,
    type ReadSummary,
    type Resolution,
    type SegmentStatus,
} from '../business/query-model';
import { findSchemaLeaf, isSet, type SegmentNode } from '../business/segment-tree';
import { isBinaryLeaf, parsePredicateValue } from '../business/stat-values';
import { formatBytes } from '../format';
import { escapeHtml, type BloomProbe } from './info-panel-manager';
import type { AnyDump } from '../types';

export interface QueryPanelDelegate {
    /** The live query state changed: overlay the resolved query on the rest of the app. */
    onUpdate(resolution: Resolution): void;
    /** The query is back to the default state (no predicates, all columns): drop any overlay. */
    onClear(): void;
    /**
     * Re-parse the file from its URL to gain the full structure, or null when
     * the dump has no fetchable source. The read summary offers it as a button
     * when a metadata-only dump limits the summary to row-group detail.
     */
    loadFullStructure: (() => void) | null;
}

const INCOMPLETE = 'incomplete — not applied';

/** Matrix cell class per resolved status kind. */
const KIND_CLASS: Record<SegmentStatus['kind'], string> = {
    read: 'qm-read',
    'eval-only': 'qm-eval',
    'not-selected': 'qm-skip',
    pruned: 'qm-pruned',
};

/** A cell's resolved bloom-filter outcome for an `=` predicate on its column
 *  (the in-flight state is handled per row group, not per cell). */
type BloomMark = '' | 'miss' | 'hit';

/** Tooltip clause per bloom mark (appended under the cell's status reason). */
const BLOOM_REASON: Record<Exclude<BloomMark, ''>, string> = {
    miss: 'Bloom filter: definitely not present — this row group is pruned.',
    hit: 'Bloom filter: maybe present — checked, could not rule it out.',
};

/** One-line footer-statistics summary for a column ("type · min · max · nulls"). */
function statsLine(dump: AnyDump, column: string): string {
    const s = columnStats(dump, column);
    if (!s) {
        return '';
    }
    const type = s.logicalType ? `${s.physicalType} (${s.logicalType})` : s.physicalType;
    if (s.unsupported) {
        return `${type} — statistics not comparable: ${s.unsupported}`;
    }
    const range =
        s.min === undefined || s.max === undefined
            ? 'no statistics written'
            : `min ${formatStatValue(s.min)} · max ${formatStatValue(s.max)}`;
    const nulls = s.nullCount === null ? 'null count unknown' : `${s.nullCount} nulls`;
    return `${type} · ${range} · ${nulls}`;
}

export class QueryPanel {
    private readonly dump: AnyDump;
    private readonly delegate: QueryPanelDelegate;
    private readonly columns: string[];
    private readonly matrix: HTMLTableElement;
    /** Floating tooltip for the matrix + the cell/header it's currently on. */
    private readonly tip: HTMLDivElement;
    private tipFor: HTMLElement | null = null;
    private readonly rowsEl: HTMLElement;
    private readonly summaryEl: HTMLElement;
    private readonly summaryNoteEl: HTMLElement;
    /** Upgrade button shown beside the summary note on metadata-only dumps. */
    private readonly summaryUpgradeBtn: HTMLButtonElement | null;
    private readonly checks: HTMLInputElement[];
    /** Per-column "type · min · max · nulls" line, shared by tooltips and rows. */
    private readonly stats: Map<string, string>;
    /** The segment tree, built once; fed to `resolve` on every edit. */
    private readonly tree: SegmentNode;
    /** The current resolved query (default state until the first edit). */
    private resolution: Resolution;
    /** Debounce handle for value-input edits. */
    private updateTimer: ReturnType<typeof setTimeout> | undefined;
    /** Live bloom probe (worker-backed); null when the dump can't be probed. */
    private readonly bloomProbe: BloomProbe | null;
    /** Cache of probe results keyed by `rg\0column\0value` -> mightContain. */
    private readonly bloomCache = new Map<string, boolean>();
    /** Probe keys currently in flight (render them as "probing"). */
    private readonly bloomInFlight = new Set<string>();
    /** Monotonic generation; a probe batch from a stale query is discarded. */
    private bloomGen = 0;
    /** The bloom info notice above the matrix (metadata/no-probe honesty). */
    private readonly bloomNoticeEl: HTMLElement;

    constructor(
        container: HTMLElement,
        dump: AnyDump,
        tree: SegmentNode,
        delegate: QueryPanelDelegate,
        bloomProbe: BloomProbe | null = null
    ) {
        this.dump = dump;
        this.tree = tree;
        this.delegate = delegate;
        this.bloomProbe = bloomProbe;
        this.columns = leafColumns(dump);
        this.stats = new Map(this.columns.map(c => [c, statsLine(dump, c)]));
        container.innerHTML = `
            <div class="query-controls-wrap">
                <p class="query-intro">
                    Predicates combine with AND — a row group is skipped when any predicate proves
                    it can't match. Pick the return columns and predicates below; everything
                    updates live, dimming what the query never reads in both the Physical File
                    Structure above and the Read Matrix below to show what is and isn't accessed.
                </p>
                <div class="info-sections query-cards">
                    <div class="info-section regular-card query-columns">
                        <h5 class="info-section-title">Return Columns</h5>
                        <div class="query-columns-actions">
                            <button type="button" id="query-select-all" class="btn btn-sm">
                                Select all
                            </button>
                            <button type="button" id="query-deselect-all" class="btn btn-sm">
                                Deselect all
                            </button>
                        </div>
                        <div class="query-columns-grid">
                            ${this.columns
                                .map(
                                    c =>
                                        `<label title="${escapeHtml(c)}"><input type="checkbox" checked data-column="${escapeHtml(c)}" /> ${escapeHtml(c)}</label>`
                                )
                                .join('')}
                        </div>
                    </div>
                    <div class="info-section regular-card query-predicates">
                        <h5 class="info-section-title">Predicates</h5>
                        <div class="query-predicate-rows"></div>
                        <div class="query-predicates-actions">
                            <button type="button" id="query-add-predicate" class="btn btn-sm">
                                Add predicate
                            </button>
                            <button type="button" id="query-clear-btn" class="btn btn-sm">
                                Clear
                            </button>
                        </div>
                        <span class="query-predicates-note">
                            predicates combine with AND; the matrix updates as you type
                        </span>
                    </div>
                    <div class="info-section large-card query-summary-card">
                        <h5 class="info-section-title">Read Summary</h5>
                        <div id="query-summary" class="info-grid"></div>
                        <p class="query-summary-note" hidden></p>
                    </div>
                </div>
            </div>
            <div class="query-matrix-section">
                <h2>Read Matrix</h2>
                <p class="query-bloom-notice" hidden></p>
                <div class="query-matrix-wrap"><table class="query-matrix"></table></div>
                <div class="query-legend">
                    <span><span class="qm-swatch qm-read"></span>read and returned</span>
                    <span><span class="qm-swatch qm-eval"></span>read only to evaluate a predicate — not in the output</span>
                    <span><span class="qm-swatch qm-pruned"></span>skipped — a predicate pruned the row group</span>
                    <span><span class="qm-swatch qm-skip"></span>not read — not selected for output</span>
                </div>
                <div class="query-legend query-legend-bloom">
                    <span class="query-legend-label">bloom filter (on the = predicate's column):</span>
                    <span><span class="qm-swatch qm-pruned"><span class="qm-bloom qm-bloom-miss"></span></span>proven absent — row group pruned</span>
                    <span><span class="qm-swatch qm-read"><span class="qm-bloom qm-bloom-hit"></span></span>may be present — kept</span>
                </div>
            </div>`;
        this.matrix = container.querySelector('.query-matrix')!;
        this.bloomNoticeEl = container.querySelector('.query-bloom-notice')!;
        // Delegated: the notice's upgrade button (re-rendered on every update).
        if (this.delegate.loadFullStructure) {
            this.bloomNoticeEl.addEventListener('click', e => {
                if ((e.target as HTMLElement).closest('.recovery-btn')) {
                    this.delegate.loadFullStructure!();
                }
            });
        }
        this.tip = document.createElement('div');
        this.tip.className = 'qm-tip';
        this.tip.hidden = true;
        // Lives in the section (destroyed with the panel on reset — no leak),
        // but position:fixed so the wrap's overflow never clips it.
        container.querySelector('.query-matrix-section')!.appendChild(this.tip);
        this.setupMatrixTooltip();
        this.rowsEl = container.querySelector('.query-predicate-rows')!;
        this.summaryEl = container.querySelector('#query-summary')!;
        this.summaryNoteEl = container.querySelector('.query-summary-note')!;
        // Same recovery affordance as the info panel's degraded cards: when a
        // metadata-only dump limits the summary and the source is fetchable,
        // offer to re-parse the full structure. Shown/hidden with the note.
        if (this.delegate.loadFullStructure) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn recovery-btn';
            btn.textContent = 'Load full structure from source';
            btn.hidden = true;
            btn.addEventListener('click', this.delegate.loadFullStructure);
            this.summaryNoteEl.insertAdjacentElement('afterend', btn);
            this.summaryUpgradeBtn = btn;
        } else {
            this.summaryUpgradeBtn = null;
        }
        this.checks = [...container.querySelectorAll<HTMLInputElement>('.query-columns input')];
        container
            .querySelector('#query-select-all')!
            .addEventListener('click', () => this.setAllColumns(true));
        container
            .querySelector('#query-deselect-all')!
            .addEventListener('click', () => this.setAllColumns(false));
        container.querySelector('#query-add-predicate')!.addEventListener('click', () => {
            this.addPredicateRow();
            this.update();
        });
        container.querySelector('#query-clear-btn')!.addEventListener('click', () => this.clear());
        this.checks.forEach(cb => cb.addEventListener('change', () => this.update()));
        // Initial paint only: the default state (no predicates, everything
        // projected) has nothing to overlay, and calling the delegate here
        // would clear a `q=` permalink before main.ts has read it.
        this.resolution = resolve(dump, this.tree, this.readState());
        this.render();
    }

    /** Restore a permalink state: rebuild the builder and evaluate it. */
    applyState(state: QueryState): void {
        const known = new Set(this.columns);
        this.rowsEl.innerHTML = '';
        state.predicates.filter(p => known.has(p.column)).forEach(p => this.addPredicateRow(p));
        const selected = new Set(state.columns);
        this.checks.forEach(cb => {
            cb.checked = selected.has(cb.dataset['column']!);
        });
        this.update();
    }

    private setAllColumns(checked: boolean): void {
        this.checks.forEach(cb => {
            cb.checked = checked;
        });
        this.update();
    }

    private addPredicateRow(preset?: Predicate): void {
        const row = document.createElement('div');
        row.className = 'query-predicate';
        const options = (values: [string, string][]): string =>
            values
                .map(
                    ([v, label]) => `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`
                )
                .join('');
        row.innerHTML = `
            <select class="qp-column" aria-label="Column">
                ${options([...this.columns].sort((a, b) => a.localeCompare(b)).map(c => [c, c]))}
            </select>
            <select class="qp-op" aria-label="Operator">
                ${options(Object.entries(OP_LABEL))}
            </select>
            <input type="text" class="qp-value" placeholder="value" />
            <button type="button" class="qp-remove btn btn-sm" aria-label="Remove predicate">
                &times;
            </button>
            <span class="qp-hint"></span>
            <span class="qp-stats"></span>`;
        if (preset) {
            row.querySelector<HTMLSelectElement>('.qp-column')!.value = preset.column;
            row.querySelector<HTMLSelectElement>('.qp-op')!.value = preset.op;
            row.querySelector<HTMLInputElement>('.qp-value')!.value = preset.value;
        }
        // Show the selected column's stats (the range a predicate prunes
        // against), live on column change.
        const columnSel = row.querySelector<HTMLSelectElement>('.qp-column')!;
        const statsEl = row.querySelector<HTMLElement>('.qp-stats')!;
        const showStats = (): void => {
            statsEl.textContent = this.stats.get(columnSel.value) ?? '';
        };
        columnSel.addEventListener('change', () => {
            showStats();
            this.update();
        });
        showStats();
        row.querySelector('.qp-op')!.addEventListener('change', () => this.update());
        row.querySelector('.qp-remove')!.addEventListener('click', () => {
            row.remove();
            this.update();
        });
        row.querySelector('.qp-value')!.addEventListener('input', () => this.scheduleUpdate());
        this.rowsEl.appendChild(row);
    }

    private readRow(row: Element): Predicate {
        return {
            column: row.querySelector<HTMLSelectElement>('.qp-column')!.value,
            op: row.querySelector<HTMLSelectElement>('.qp-op')!.value as Op,
            value: row.querySelector<HTMLInputElement>('.qp-value')!.value,
        };
    }

    /** The builder's current predicates + projection, straight from the DOM. */
    private readState(): QueryState {
        const predicates = [...this.rowsEl.querySelectorAll('.query-predicate')].map(row =>
            this.readRow(row)
        );
        const columns = this.checks.filter(cb => cb.checked).map(cb => cb.dataset['column']!);
        return { predicates, columns };
    }

    /** Debounced update for value-input edits (typing re-evaluates live). */
    private scheduleUpdate(): void {
        clearTimeout(this.updateTimer);
        this.updateTimer = setTimeout(() => this.update(), 150);
    }

    /**
     * Re-evaluate the live state: invalid predicate rows are excluded (and
     * hinted), valid ones run through the engine, and the delegate follows —
     * back to onClear when the state degenerates to the default (nothing to
     * overlay, no `q=` permalink).
     */
    private update(): void {
        clearTimeout(this.updateTimer);
        const { columns } = this.readState();
        const valid: Predicate[] = [];
        for (const row of this.rowsEl.querySelectorAll('.query-predicate')) {
            const predicate = this.readRow(row);
            const ok = isValidPredicate(this.dump, predicate);
            row.querySelector<HTMLElement>('.qp-hint')!.textContent = ok ? '' : INCOMPLETE;
            if (ok) {
                valid.push(predicate);
            }
        }
        // Resolve synchronously (folding in whatever bloom results are already
        // cached), then kick off any new bloom probes; their results re-resolve.
        this.applyResolution(valid, columns);
        this.refineWithBloom(valid, columns);
    }

    /** Resolve + render + drive the delegate, folding in cached bloom results. */
    private applyResolution(valid: Predicate[], columns: string[]): void {
        this.resolution = resolve(
            this.dump,
            this.tree,
            { predicates: valid, columns },
            this.buildBloomResults(valid)
        );
        this.render();
        if (this.resolution.active) {
            this.delegate.onUpdate(this.resolution);
        } else {
            this.delegate.onClear();
        }
    }

    /** `rg\0column\0value` — the probe-result cache key. */
    private bloomKey(rg: number, column: string, value: string): string {
        return `${rg} ${column} ${value}`;
    }

    /** The probe string for an `=` predicate value, or null when the column is
     *  binary / the value doesn't parse (bloom isn't consulted for those). */
    private probeValue(column: string, value: string): string | null {
        const leaf = findSchemaLeaf(this.dump.metadata.schema_root, column);
        if (!leaf || isBinaryLeaf(leaf)) {
            return null;
        }
        const parsed = parsePredicateValue(value, leaf);
        return parsed === undefined ? null : String(parsed);
    }

    /** Whether (rg, column) carries a bloom filter (from the footer metadata). */
    private columnHasBloom(rg: number, column: string): boolean {
        const chunk = this.dump.metadata.row_groups[rg]?.column_chunks[column];
        return isSet(chunk?.metadata.bloom_filter_offset);
    }

    /**
     * Assemble the cached bloom outcomes for the valid `=` predicates into the
     * shape `resolve` folds in (per-predicate miss/hit row-group sets). Only
     * cached results appear; un-probed row groups are simply absent.
     */
    private buildBloomResults(valid: Predicate[]): BloomResults {
        const out: BloomResults = new Map();
        if (!this.bloomProbe) {
            return out;
        }
        valid.forEach((p, i) => {
            if (p.op !== 'eq') {
                return;
            }
            const value = this.probeValue(p.column, p.value);
            if (value === null) {
                return;
            }
            const misses = new Set<number>();
            const hits = new Set<number>();
            this.dump.metadata.row_groups.forEach((_g, rg) => {
                const r = this.bloomCache.get(this.bloomKey(rg, p.column, value));
                if (r !== undefined) {
                    (r ? hits : misses).add(rg);
                }
            });
            if (misses.size > 0 || hits.size > 0) {
                out.set(i, { misses, hits });
            }
        });
        return out;
    }

    /**
     * Fire bloom probes for every (row group × `=` predicate) that has a filter
     * and wasn't already pruned by statistics (bloom adds nothing there). Newly
     * in-flight cells render as "probing"; when the batch settles it re-resolves
     * with the results folded in. A generation guard drops a stale batch whose
     * query has since changed.
     */
    private refineWithBloom(valid: Predicate[], columns: string[]): void {
        const gen = ++this.bloomGen;
        if (!this.bloomProbe) {
            return;
        }
        const probes: Promise<void>[] = [];
        for (const p of valid) {
            if (p.op !== 'eq') {
                continue;
            }
            const value = this.probeValue(p.column, p.value);
            if (value === null) {
                continue;
            }
            this.dump.metadata.row_groups.forEach((_g, rg) => {
                if (
                    !this.columnHasBloom(rg, p.column) ||
                    this.resolution.matrixCell(rg, p.column).kind === 'pruned'
                ) {
                    return;
                }
                const key = this.bloomKey(rg, p.column, value);
                if (this.bloomCache.has(key) || this.bloomInFlight.has(key)) {
                    return;
                }
                this.bloomInFlight.add(key);
                probes.push(
                    this.bloomProbe!(rg, p.column, value).then(
                        res => {
                            this.bloomInFlight.delete(key);
                            this.bloomCache.set(key, res.mightContain);
                        },
                        () => {
                            // A failed probe leaves no cache entry (no marker) —
                            // honest: we simply couldn't consult the filter.
                            this.bloomInFlight.delete(key);
                        }
                    )
                );
            });
        }
        if (probes.length === 0) {
            return;
        }
        this.render(); // show "probing" markers on the in-flight cells
        void Promise.all(probes).then(() => {
            if (gen === this.bloomGen) {
                this.applyResolution(valid, columns);
            }
        });
    }

    /** Drop all predicates; the matrix falls back to the projection-only view. */
    private clear(): void {
        this.rowsEl.innerHTML = '';
        this.update();
    }

    /**
     * Redraw the matrix + summary from the resolved query. Each cell's fate and
     * wording come from `resolution.matrixCell` — the panel holds no precedence.
     */
    private render(): void {
        const head = `<tr><th class="qm-rowhead"></th>${this.columns
            .map(
                c =>
                    `<th title="${escapeHtml(`${c}\n${this.stats.get(c)}`)}"><span>${escapeHtml(c)}</span></th>`
            )
            .join('')}</tr>`;
        const body = this.dump.metadata.row_groups
            .map((_, index) => {
                // A row group whose bloom probe is in flight has an unknown fate:
                // hold its (read/eval/pruned) cells in a neutral "checking" state
                // so they settle straight to the result, never read-then-pruned.
                const probing = this.rowProbing(index);
                const cells = this.columns
                    .map(column => {
                        const s = this.resolution.matrixCell(index, column);
                        // not-selected doesn't depend on pruning, so it stays gray
                        // even while the row group is being probed.
                        if (probing && s.kind !== 'not-selected') {
                            const t = `${column}\nChecking the bloom filter…`;
                            return `<td class="qm-cell qm-probing" title="${escapeHtml(t)}"></td>`;
                        }
                        // Column name, then the status + its rationale (the reason
                        // already reads "Status — why"). Per-column stats live on
                        // the header, not here.
                        const mark = this.bloomMark(index, column);
                        const dot = mark
                            ? `<span class="qm-bloom qm-bloom-${mark}" aria-hidden="true"></span>`
                            : '';
                        const title = mark
                            ? `${column}\n${s.reason}\n${BLOOM_REASON[mark]}`
                            : `${column}\n${s.reason}`;
                        return `<td class="qm-cell ${KIND_CLASS[s.kind]}" title="${escapeHtml(title)}">${dot}</td>`;
                    })
                    .join('');
                return `<tr><th class="qm-rowhead">RG${index}</th>${cells}</tr>`;
            })
            .join('');
        this.matrix.innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
        // The old cell/header the tooltip tracked is gone with the innerHTML.
        this.tipFor = null;
        this.tip.hidden = true;
        this.renderBloomNotice();
        this.renderSummary(this.resolution.summary);
    }

    /**
     * The resolved bloom outcome to mark on cell (rg, column): a cached miss (the
     * row group is pruned) wins over a cached hit. Empty when bloom can't be
     * consulted or nothing has resolved for this cell. In-flight probes are shown
     * as a whole-row "probing" state (rowProbing), not here.
     */
    private bloomMark(rg: number, column: string): BloomMark {
        if (!this.bloomProbe) {
            return '';
        }
        let mark: BloomMark = '';
        for (const p of this.resolution.state.predicates) {
            if (p.op !== 'eq' || p.column !== column) {
                continue;
            }
            const value = this.probeValue(column, p.value);
            if (value === null) {
                continue;
            }
            const cached = this.bloomCache.get(this.bloomKey(rg, column, value));
            if (cached === false) {
                return 'miss';
            }
            if (cached === true) {
                mark = 'hit';
            }
        }
        return mark;
    }

    /**
     * Whether row group `rg` has a bloom probe in flight — its fate is not yet
     * known, so its cells render a neutral "checking" pulse rather than a
     * premature read/pruned color that would flip when the result lands.
     */
    private rowProbing(rg: number): boolean {
        if (!this.bloomProbe) {
            return false;
        }
        return this.resolution.state.predicates.some(p => {
            if (p.op !== 'eq') {
                return false;
            }
            const value = this.probeValue(p.column, p.value);
            return value !== null && this.bloomInFlight.has(this.bloomKey(rg, p.column, value));
        });
    }

    /**
     * Honest notice above the matrix when the file HAS bloom filters that a real
     * reader would use for an `=` predicate, but this dump can't probe them (a
     * JSON/metadata dump with no fetchable source). The simulation is then an
     * upper bound on rows read; offer the upgrade when a source exists. Hidden
     * whenever we can actually probe (we just do it) or nothing applies.
     */
    private renderBloomNotice(): void {
        const el = this.bloomNoticeEl;
        if (this.bloomProbe) {
            el.hidden = true;
            return;
        }
        // Columns with an `=` predicate, a bloom filter, and at least one row
        // group that survived stats pruning (where bloom could still skip more).
        const columns = new Set<string>();
        for (const p of this.resolution.state.predicates) {
            if (p.op !== 'eq') {
                continue;
            }
            const survives = this.dump.metadata.row_groups.some(
                (_g, rg) =>
                    this.columnHasBloom(rg, p.column) &&
                    this.resolution.matrixCell(rg, p.column).kind !== 'pruned'
            );
            if (survives) {
                columns.add(p.column);
            }
        }
        if (columns.size === 0) {
            el.hidden = true;
            return;
        }
        const names = [...columns].map(c => `<code>${escapeHtml(c)}</code>`).join(', ');
        const upgrade = this.delegate.loadFullStructure
            ? ` <button type="button" class="btn btn-sm recovery-btn">Load full structure from source</button>`
            : '';
        el.innerHTML =
            `This file has a bloom filter on ${names}. A real reader could skip more row ` +
            `groups for that <code>=</code> predicate, but the filter isn't in this ` +
            `${'column_chunks' in this.dump ? 'dump' : 'metadata-only export'} — the matrix is an ` +
            `upper bound on what's read.${upgrade}`;
        el.hidden = false;
    }

    /**
     * Instant floating tooltip for every cell and column header. Native `title`
     * is kept (a11y + tests read it) but stashed away while a target is hovered
     * so the browser's slow duplicate never shows. Delegated on the persistent
     * table, so it survives each render()'s innerHTML swap. The `t === tipFor`
     * guard makes re-entry from a header's inner <span> a no-op instead of a
     * flicker; mouseout only hides once the pointer truly leaves the target.
     */
    private setupMatrixTooltip(): void {
        const TARGETS = '.qm-cell, thead th:not(.qm-rowhead)';
        const restore = (t: HTMLElement): void => {
            if (t.dataset['tip'] !== undefined) {
                t.setAttribute('title', t.dataset['tip']);
                delete t.dataset['tip'];
            }
        };
        this.matrix.addEventListener('mouseover', e => {
            const t = (e.target as HTMLElement).closest<HTMLElement>(TARGETS);
            if (!t || t === this.tipFor) {
                return;
            }
            if (this.tipFor) {
                restore(this.tipFor);
            }
            this.tipFor = t;
            const title = t.getAttribute('title');
            if (title === null) {
                return;
            }
            t.dataset['tip'] = title;
            t.removeAttribute('title');
            this.tip.textContent = title;
            this.tip.hidden = false;
            this.moveTip(e);
        });
        this.matrix.addEventListener('mouseout', e => {
            const t = (e.target as HTMLElement).closest<HTMLElement>(TARGETS);
            if (t && t === this.tipFor && !t.contains(e.relatedTarget as Node)) {
                restore(t);
                this.tipFor = null;
                this.tip.hidden = true;
            }
        });
        this.matrix.addEventListener('mousemove', e => this.moveTip(e));
    }

    /** Keep the tooltip beside the cursor and inside the viewport. */
    private moveTip(e: MouseEvent): void {
        if (this.tip.hidden) {
            return;
        }
        const pad = 12;
        const r = this.tip.getBoundingClientRect();
        const left = Math.min(e.clientX + pad, window.innerWidth - r.width - pad);
        let top = e.clientY + pad;
        if (top + r.height > window.innerHeight) {
            top = e.clientY - r.height - pad;
        }
        this.tip.style.left = `${Math.max(pad, left)}px`;
        this.tip.style.top = `${Math.max(pad, top)}px`;
    }

    /**
     * Structured read summary, straight from the core's `ReadSummary`. "Up to"
     * on rows is deliberate: statistics pruning is an upper bound, never exact.
     */
    private renderSummary(summary: ReadSummary): void {
        const items: [string, string][] = [
            ['Rows', `up to ${summary.rows.kept} of ${summary.rows.total}`],
            ['Row groups', `${summary.rowGroups.read} of ${summary.rowGroups.total} read`],
            ['Column chunks', `${summary.columnChunks.read} of ${summary.columnChunks.total} read`],
        ];
        if (summary.pages) {
            items.push(['Pages', `${summary.pages.read} of ${summary.pages.total} read`]);
        }
        items.push([
            'Bytes',
            `${formatBytes(summary.bytes.read)} of ${formatBytes(summary.bytes.total)} read`,
        ]);
        this.summaryEl.innerHTML = items
            .map(
                ([label, value]) =>
                    `<div class="info-item"><span class="info-label">${escapeHtml(label)}</span>` +
                    `<span class="info-value">${escapeHtml(value)}</span></div>`
            )
            .join('');
        this.summaryNoteEl.hidden = summary.note === null;
        this.summaryNoteEl.textContent = summary.note ?? '';
        if (this.summaryUpgradeBtn) {
            this.summaryUpgradeBtn.hidden = summary.note === null;
        }
    }
}
