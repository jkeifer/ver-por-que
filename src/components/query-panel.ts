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
import type { SegmentNode } from '../business/segment-tree';
import { formatBytes } from '../format';
import { escapeHtml } from './info-panel-manager';
import type { AnyDump } from '../types';

export interface QueryPanelDelegate {
    /** The live query state changed: overlay the resolved query on the rest of the app. */
    onUpdate(resolution: Resolution): void;
    /** The query is back to the default state (no predicates, all columns): drop any overlay. */
    onClear(): void;
}

const INCOMPLETE = 'incomplete — not applied';

/** Matrix cell class per resolved status kind. */
const KIND_CLASS: Record<SegmentStatus['kind'], string> = {
    read: 'qm-read',
    'eval-only': 'qm-eval',
    'not-selected': 'qm-skip',
    pruned: 'qm-pruned',
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
    private readonly rowsEl: HTMLElement;
    private readonly summaryEl: HTMLElement;
    private readonly summaryNoteEl: HTMLElement;
    private readonly checks: HTMLInputElement[];
    /** Per-column "type · min · max · nulls" line, shared by tooltips and rows. */
    private readonly stats: Map<string, string>;
    /** The segment tree, built once; fed to `resolve` on every edit. */
    private readonly tree: SegmentNode;
    /** The current resolved query (default state until the first edit). */
    private resolution: Resolution;
    /** Debounce handle for value-input edits. */
    private updateTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        container: HTMLElement,
        dump: AnyDump,
        tree: SegmentNode,
        delegate: QueryPanelDelegate
    ) {
        this.dump = dump;
        this.tree = tree;
        this.delegate = delegate;
        this.columns = leafColumns(dump);
        this.stats = new Map(this.columns.map(c => [c, statsLine(dump, c)]));
        container.innerHTML = `
            <div class="query-matrix-wrap"><table class="query-matrix"></table></div>
            <div class="query-legend">
                <span><span class="qm-swatch qm-read"></span>read and returned</span>
                <span><span class="qm-swatch qm-eval"></span>read only to evaluate a predicate — not in the output</span>
                <span><span class="qm-swatch qm-pruned"></span>skipped — a predicate pruned the row group</span>
                <span><span class="qm-swatch qm-skip"></span>not read — not selected for output</span>
            </div>
            <div class="info-sections query-cards">
                <div class="info-section large-card query-summary-card">
                    <h5 class="info-section-title">Read Summary</h5>
                    <div id="query-summary" class="info-grid"></div>
                    <p class="query-summary-note" hidden></p>
                </div>
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
                        <button type="button" id="query-clear-btn" class="btn btn-sm">Clear</button>
                    </div>
                    <span class="query-predicates-note">
                        predicates combine with AND; the matrix updates as you type
                    </span>
                </div>
            </div>`;
        this.matrix = container.querySelector('.query-matrix')!;
        this.rowsEl = container.querySelector('.query-predicate-rows')!;
        this.summaryEl = container.querySelector('#query-summary')!;
        this.summaryNoteEl = container.querySelector('.query-summary-note')!;
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
        this.resolution = resolve(this.dump, this.tree, { predicates: valid, columns });
        this.render();
        if (this.resolution.active) {
            this.delegate.onUpdate(this.resolution);
        } else {
            this.delegate.onClear();
        }
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
                c => `<th title="${escapeHtml(`${c}\n${this.stats.get(c)}`)}">${escapeHtml(c)}</th>`
            )
            .join('')}</tr>`;
        const body = this.dump.metadata.row_groups
            .map((_, index) => {
                const cells = this.columns
                    .map(column => {
                        const s = this.resolution.matrixCell(index, column);
                        const title = `${column}\n${this.stats.get(column)}\n${s.reason}`;
                        return `<td class="qm-cell ${KIND_CLASS[s.kind]}" title="${escapeHtml(title)}"></td>`;
                    })
                    .join('');
                return `<tr><th class="qm-rowhead">RG${index}</th>${cells}</tr>`;
            })
            .join('');
        this.matrix.innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
        this.renderSummary(this.resolution.summary);
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
    }
}
