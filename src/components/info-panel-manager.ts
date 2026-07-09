/**
 * Info Panel Manager
 *
 * Owns the info panel element and its lifecycle: for a selected segment it asks
 * the declarative registry (`info-panel/panels`) for the sections, renders them,
 * and appends the interactive bloom-probe / value-preview / dictionary cards
 * when a live worker file backs them. The pure rendering lives in the
 * `info-panel/` modules; this file is orchestration + DOM wiring.
 */
import { geoparquetColumns, isWkbColumn } from '../domain/geoparquet';
import { OP_LABEL } from '../business/pruning';
import type { Resolution } from '../business/query-model';
import { describe, findSchemaLeaf, type SegmentNode } from '../business/segment-tree';
import { base64Bytes, isBinaryLeaf, parsePredicateValue } from '../business/stat-values';
import { wkbToGeoJson } from '../business/wkb';
import type {
    BloomDensityResult,
    BloomProbeBit,
    BloomProbeResult,
    DictionaryPreviewResult,
    PreviewResult,
} from '../js/worker/pyodide-parquet';
import type { AnyDump } from '../types';
import {
    copyButton,
    copyGeoJsonButton,
    copyPhysicalButton,
    escapeHtml,
    type Row,
    type Section,
} from './info-panel/view';
import {
    appendRecovery,
    isIncrementalReadError,
    RANGE_UNSUPPORTED_MESSAGE,
    type RecoveryActions,
} from './info-panel/recovery';
import { blockCellInner, renderBloomLineage, renderBloomStrip } from './info-panel/bloom-view';
import {
    renderDictionaryWindow,
    renderPreviewFailure,
    renderPreviewWindow,
} from './info-panel/preview-view';
import { PANEL_KINDS, panelSections } from './info-panel/panels';

// Re-exported so existing importers (visualizers, query panel, tests) keep a
// single entry point for the panel's public surface.
export { escapeHtml, isIncrementalReadError, PANEL_KINDS };
export type { RecoveryActions };

const BLOOM_PROBE_UNAVAILABLE_NOTE =
    'Probing needs the filter bytes — load the original .parquet to test values.';

const VALUE_PREVIEW_UNAVAILABLE_NOTE =
    'Decoding values needs the file bytes — load the original .parquet to preview values.';

/**
 * Tests a value against a column chunk's bloom filter. Only raw-parquet loads
 * have one (the worker holds the file); the value crosses as a string.
 */
export type BloomProbe = (
    rowGroup: number,
    column: string,
    value: string
) => Promise<BloomProbeResult>;

/**
 * Reads a column chunk's whole bloom filter and reduces it to a density strip.
 * Only raw-parquet loads have one, same lifecycle as BloomProbe.
 */
export type BloomDensity = (rowGroup: number, column: string) => Promise<BloomDensityResult>;

/**
 * Reads a contiguous run of `count` 256-bit blocks' raw bytes (base64) from a
 * column chunk's bloom filter, so a window of block bit-grids renders on demand
 * at any filter size in one call. Same lifecycle as BloomDensity.
 */
export type BloomBlocks = (
    rowGroup: number,
    column: string,
    start: number,
    count: number
) => Promise<string>;

/**
 * Decodes a window of a data page in the worker's current file, starting at
 * value `offset`; with `skipNulls` the window is up to `limit` non-null values.
 * Only raw-parquet loads have one, same as BloomProbe.
 */
export type ValuePreview = (
    rowGroup: number,
    column: string,
    pageIndex: number,
    offset: number,
    limit: number,
    skipNulls: boolean
) => Promise<PreviewResult>;

/**
 * Decodes a window of a column chunk's dictionary page (its distinct values) in
 * the worker's current file, from entry `offset`. Only raw-parquet loads have
 * one, same lifecycle as ValuePreview.
 */
export type DictionaryPreview = (
    rowGroup: number,
    column: string,
    offset: number,
    limit: number
) => Promise<DictionaryPreviewResult>;

/** Values shown per preview page; the worker decodes the whole page once. */
const PREVIEW_PAGE_SIZE = 100;

/** Where a value preview points: a data page's coordinates in the worker's file. */
interface PreviewTarget {
    rowGroup: number;
    column: string;
    pageIndex: number;
}

export class InfoPanelManager {
    private container: HTMLElement;
    private infoPanel: HTMLElement;
    /** Live bloom-filter probe; null for JSON-dump / metadata-only loads. */
    private bloomProbe: BloomProbe | null;
    /** Live whole-filter density reader; same lifecycle as bloomProbe. */
    private bloomDensity: BloomDensity | null;
    /** Live block-range byte reader; same lifecycle as bloomProbe. */
    private bloomBlocks: BloomBlocks | null;
    /** Live value decoder; null for JSON-dump / metadata-only loads. */
    private valuePreview: ValuePreview | null;
    /** Live dictionary decoder; same lifecycle as valuePreview. */
    private dictionaryPreview: DictionaryPreview | null;
    /** Recovery actions for degraded cards; both null when no fetchable source. */
    private recovery: RecoveryActions;
    /** Active query resolution, or null when no predicate has run. */
    private query: Resolution | null = null;
    /** Last shown node/dump, so a query run can refresh the open panel. */
    private current: { node: SegmentNode; dump: AnyDump } | null = null;
    /** Live ResizeObserver re-virtualizing the open bloom section's block strip
     *  (visible window + minimap box) on width changes; disconnected and dropped
     *  whenever the panel is re-shown or hidden (no leak). */
    private bloomResizeObserver: ResizeObserver | null = null;

    constructor(
        container: HTMLElement,
        bloomProbe: BloomProbe | null = null,
        bloomDensity: BloomDensity | null = null,
        bloomBlocks: BloomBlocks | null = null,
        valuePreview: ValuePreview | null = null,
        dictionaryPreview: DictionaryPreview | null = null,
        recovery: RecoveryActions = { loadFullStructure: null, downloadFullFile: null }
    ) {
        this.container = container;
        this.container.innerHTML = '';
        this.bloomProbe = bloomProbe;
        this.bloomDensity = bloomDensity;
        this.bloomBlocks = bloomBlocks;
        this.valuePreview = valuePreview;
        this.dictionaryPreview = dictionaryPreview;
        this.recovery = recovery;
        this.infoPanel = document.createElement('div');
        this.infoPanel.className = 'info-panel';
        this.infoPanel.style.display = 'none';
        this.container.appendChild(this.infoPanel);
        // Delegated: copy buttons live in truncated stat/kv/preview cells that
        // are re-rendered often, so listen once on the stable panel.
        this.infoPanel.addEventListener('click', e => {
            const btn = (e.target as HTMLElement).closest('.copy-btn');
            if (!(btn instanceof HTMLElement)) {
                return;
            }
            let text: string | undefined;
            if (btn.dataset.copyWkb !== undefined) {
                // Lazy: decode base64 WKB to GeoJSON only when actually copied.
                const bytes = base64Bytes(btn.dataset.copyWkb);
                const geo = bytes && wkbToGeoJson(bytes);
                text = geo ? JSON.stringify(geo) : undefined;
            } else if (btn.dataset.copy !== undefined) {
                text = btn.dataset.copy;
            }
            if (text !== undefined) {
                void navigator.clipboard?.writeText(text);
                btn.classList.add('copied');
                window.setTimeout(() => btn.classList.remove('copied'), 1000);
            }
        });
    }

    /**
     * Set (or clear) the query overlay. Only the "Query Pruning" section
     * depends on the query, so this patches that one section in place rather
     * than rebuilding the whole panel — a full rebuild on every query edit
     * (each column toggle / keystroke) re-rendered unrelated DOM, including an
     * open value-preview table, which was both wasteful and janky.
     */
    setQuery(resolution: Resolution | null): void {
        this.query = resolution;
        if (this.current) {
            this.updateQuerySection();
        }
    }

    /**
     * Insert, replace, or remove just the current node's "Query Pruning"
     * section. Placed before the interactive bloom/preview sections so its
     * position is identical whether it's built during show() or a later
     * setQuery, and so patching it never disturbs those live widgets.
     */
    private updateQuerySection(): void {
        const container = this.infoPanel.querySelector('.info-sections');
        if (!container) {
            return;
        }
        container.querySelector('.query-pruning-section')?.remove();
        const section = this.current ? this.querySection(this.current.node) : null;
        if (!section) {
            return;
        }
        const wrap = document.createElement('div');
        wrap.innerHTML = this.renderSection(section);
        const el = wrap.firstElementChild as HTMLElement;
        el.classList.add('query-pruning-section');
        const anchor = container.querySelector('.bloom-probe-section, .value-preview-section');
        container.insertBefore(el, anchor);
    }

    /** The query decision for this node, if the query resolved a status for it. */
    private querySection(node: SegmentNode): Section | null {
        const status = this.query?.statusOf(node.id);
        if (!status) {
            return null;
        }
        const predicates = this.query!.state.predicates;
        const label = predicates.map(p => `${p.column} ${OP_LABEL[p.op]} ${p.value}`).join(' AND ');
        const rows: Row[] = [];
        if (predicates.length > 0) {
            rows.push([predicates.length === 1 ? 'Predicate' : 'Predicates (AND)', label]);
        }
        rows.push(['Decision', status.reason]);
        return { title: 'Query Pruning', rows };
    }

    /** Render the panel for a segment node (the root node renders the overview). */
    show(node: SegmentNode, dump: AnyDump): void {
        // Re-showing replaces the panel wholesale; drop the previous bloom
        // section's ResizeObserver so it never observes a detached element.
        this.teardownBloom();
        this.current = { node, dump };
        const heading = node.kind === 'file' ? 'File Overview' : describe(node);
        const sections = panelSections(node, dump);
        if (node.kind === 'bloom_filter' && !this.bloomProbe) {
            // No live worker file (JSON dump, metadata export, or restore):
            // same degradation pattern as METADATA_ONLY_NOTE.
            sections.push({
                title: 'Probe a Value',
                rows: [['Detail', BLOOM_PROBE_UNAVAILABLE_NOTE]],
            });
        }
        const preview = this.previewTarget(node);
        if (preview && !this.valuePreview) {
            // Same degradation pattern as the bloom probe above.
            sections.push({
                title: 'Value Preview',
                rows: [['Detail', VALUE_PREVIEW_UNAVAILABLE_NOTE]],
            });
        }
        if (node.kind === 'dictionary_page' && !this.dictionaryPreview) {
            sections.push({
                title: 'Dictionary Values',
                rows: [['Detail', VALUE_PREVIEW_UNAVAILABLE_NOTE]],
            });
        }
        this.infoPanel.style.display = 'block';
        this.infoPanel.innerHTML = `<h3>${heading}</h3><div class="info-sections">${sections
            .map(s => this.renderSection(s))
            .join('')}</div>`;
        if (this.recovery.loadFullStructure) {
            const upgrade = this.recovery.loadFullStructure;
            this.infoPanel
                .querySelectorAll('.recovery-btn[data-action="upgrade"]')
                .forEach(btn => btn.addEventListener('click', upgrade));
        }
        if (node.kind === 'bloom_filter' && this.bloomProbe) {
            this.infoPanel
                .querySelector('.info-sections')!
                .appendChild(this.buildBloomProbeSection(node, dump));
        }
        if (preview && this.valuePreview) {
            const leaf = findSchemaLeaf(dump.metadata.schema_root, preview.column);
            // Native GEOMETRY/GEOGRAPHY logical types, or a GeoParquet WKB column
            // (plain BYTE_ARRAY described in the `geo` metadata, e.g. Overture).
            const isWkb = isWkbColumn(leaf, geoparquetColumns(dump)[preview.column]);
            this.infoPanel
                .querySelector('.info-sections')!
                .appendChild(this.buildValuePreviewSection(preview, isWkb));
        }
        if (node.kind === 'dictionary_page' && this.dictionaryPreview) {
            const leaf = findSchemaLeaf(dump.metadata.schema_root, node.path);
            const isWkb = isWkbColumn(leaf, geoparquetColumns(dump)[node.path]);
            this.infoPanel
                .querySelector('.info-sections')!
                .appendChild(this.buildDictionaryPreviewSection(node.rowGroup, node.path, isWkb));
        }
        // Query section last: it anchors before the interactive sections above,
        // matching where a later setQuery will re-insert it.
        this.updateQuerySection();
    }

    /** The page a node previews, or null when it has none (only data pages do). */
    private previewTarget(node: SegmentNode): PreviewTarget | null {
        if (node.kind === 'data_page') {
            return { rowGroup: node.rowGroup, column: node.path, pageIndex: node.pageIndex };
        }
        return null;
    }

    /** Interactive value preview: decode this page's values on demand. */
    private buildValuePreviewSection(target: PreviewTarget, isWkb: boolean): HTMLElement {
        const section = document.createElement('div');
        section.className = 'info-section large-card value-preview-section';
        section.innerHTML =
            `<h5 class="info-section-title">Value Preview</h5>` +
            `<button type="button" class="btn btn-sm value-preview-btn">Preview values</button>` +
            `<div class="value-preview-result"></div>`;
        const button = section.querySelector<HTMLButtonElement>('.value-preview-btn')!;
        const result = section.querySelector<HTMLElement>('.value-preview-result')!;
        // "hide nulls" is a worker-side scan mode, not a client filter: each
        // window is up to PREVIEW_PAGE_SIZE non-null values, so its span can skip
        // over far more of the page. That makes window starts irregular, so Prev
        // walks a history of the starts we paged through rather than arithmetic.
        let hideNulls = false;
        const history: number[] = [];
        // Fetch one window and render it with its pager; prev/next/toggle re-invoke
        // this. The first call decodes the page (may read bytes / fail); later
        // calls hit the worker's cached page, so they're local and effectively
        // can't fail. Pager nav leaves the current table in place until the new
        // window swaps in (no blanking flash); only the initial click spins.
        const load = (offset: number): void => {
            this.valuePreview!(
                target.rowGroup,
                target.column,
                target.pageIndex,
                offset,
                PREVIEW_PAGE_SIZE,
                hideNulls
            ).then(
                res => {
                    button.remove();
                    if (res.error !== undefined) {
                        result.innerHTML = renderPreviewFailure(res.codec);
                        return;
                    }
                    renderPreviewWindow(result, {
                        entries: res.values,
                        start: offset,
                        next: res.next,
                        total: res.total,
                        nulls: res.nulls,
                        hideNulls,
                        isWkb,
                        canPrev: history.length > 0,
                        // Toggling the mode resets to the top of the page.
                        onToggleNulls: hide => {
                            hideNulls = hide;
                            history.length = 0;
                            load(0);
                        },
                        onPrev: () => load(history.pop() ?? 0),
                        onNext: () => {
                            history.push(offset);
                            load(res.next);
                        },
                    });
                },
                (error: unknown) => this.handlePreviewError(error, result, button)
            );
        };
        button.addEventListener('click', () => {
            button.disabled = true;
            result.textContent = 'Decoding values...';
            load(0);
        });
        return section;
    }

    /**
     * Shared failure handler for the value/dictionary previews: a
     * range-unsupported error offers a full-file download; anything else shows
     * the (retryable) failure and re-enables the button.
     */
    private handlePreviewError(
        error: unknown,
        result: HTMLElement,
        button: HTMLButtonElement
    ): void {
        if (isIncrementalReadError(error) && this.recovery.downloadFullFile) {
            button.remove();
            result.innerHTML = '';
            appendRecovery(
                result,
                RANGE_UNSUPPORTED_MESSAGE,
                'Download full file',
                this.recovery.downloadFullFile
            );
            return;
        }
        // Pyodide errors embed the python traceback; the last line is the actual
        // exception. Keep the button so it's retryable.
        const message = (error as Error).message.trim();
        button.disabled = false;
        result.textContent = `Preview failed: ${message.split('\n').pop()!}`;
    }

    /** Interactive dictionary preview: decode this chunk's distinct values on demand. */
    private buildDictionaryPreviewSection(
        rowGroup: number,
        column: string,
        isWkb: boolean
    ): HTMLElement {
        const section = document.createElement('div');
        section.className = 'info-section large-card value-preview-section';
        section.innerHTML =
            `<h5 class="info-section-title">Dictionary Values</h5>` +
            `<button type="button" class="btn btn-sm value-preview-btn">Preview dictionary values</button>` +
            `<div class="value-preview-result"></div>`;
        const button = section.querySelector<HTMLButtonElement>('.value-preview-btn')!;
        const result = section.querySelector<HTMLElement>('.value-preview-result')!;
        // Dictionary paging is plain arithmetic (no null-skip): the window at
        // `offset` is [offset, offset+PREVIEW_PAGE_SIZE). The dictionary is
        // decoded once worker-side, so later pages are local and can't fail.
        const load = (offset: number): void => {
            this.dictionaryPreview!(rowGroup, column, offset, PREVIEW_PAGE_SIZE).then(
                res => {
                    button.remove();
                    if (res.error !== undefined) {
                        result.innerHTML = renderPreviewFailure(res.codec);
                        return;
                    }
                    renderDictionaryWindow(result, {
                        entries: res.values,
                        start: offset,
                        next: res.next,
                        total: res.total,
                        canPrev: offset > 0,
                        isWkb,
                        onPrev: () => load(Math.max(0, offset - PREVIEW_PAGE_SIZE)),
                        onNext: () => load(res.next),
                    });
                },
                (error: unknown) => this.handlePreviewError(error, result, button)
            );
        };
        button.addEventListener('click', () => {
            button.disabled = true;
            result.textContent = 'Decoding values...';
            load(0);
        });
        return section;
    }

    /**
     * Interactive bloom-filter section (full-width). Probe text (value → hash →
     * block lineage and the verdict) sits at the top, above a horizontally-
     * scrollable strip of every 256-bit block as a full-res bit-grid, with the
     * density-heatmap strip below it acting as the block strip's scrollbar. The
     * block strip is VIRTUALIZED — only the visible window
     * (plus a small buffer) is mounted, absolutely positioned in a full-width
     * track — so a filter of any size stays cheap; each visible block lazily
     * fetches its bytes (batched range reads) and a filled slot is final. Its
     * native scrollbar is hidden: the density strip IS the scrollbar. A toned-down
     * viewport box on the strip tracks the visible window (from scrollLeft), and
     * pressing/dragging the strip scrubs it. Probing marks the block it lands in
     * on both the strip and the block strip (hit/miss on the eight checked bits),
     * shows the lineage + verdict up top, and scrolls that block into view. Clear
     * drops the probe overlay only.
     */
    private buildBloomProbeSection(
        node: Extract<SegmentNode, { kind: 'bloom_filter' }>,
        dump: AnyDump
    ): HTMLElement {
        const leaf = findSchemaLeaf(dump.metadata.schema_root, node.path);
        // Binary columns (geometry/UUID/raw binary) aren't typeable as text; the
        // probe takes base64 of the raw bytes and the worker decodes it.
        const binary = leaf ? isBinaryLeaf(leaf) : false;
        const section = document.createElement('div');
        section.className = 'info-section large-card bloom-probe-section';
        section.innerHTML =
            `<h5 class="info-section-title">Probe a Value</h5>` +
            `<div class="bloom-probe-controls">` +
            `<input type="text" class="bloom-probe-value" placeholder="${
                leaf ? `${leaf.type} value${binary ? ' (base64)' : ''}` : 'value'
            }">` +
            `<button type="button" class="btn btn-sm bloom-probe-btn">Probe</button>` +
            `<button type="button" class="btn btn-sm bloom-probe-clear" disabled>Clear</button>` +
            `</div>` +
            // Probe text up top so it correlates with the input and stays put
            // while the block strip scrolls elsewhere. One fixed-height status
            // area holds an explanatory hint until probed, then the lineage +
            // verdict — same reserved height either way, so nothing shifts.
            `<div class="bloom-probe-status"></div>` +
            `<div class="bloom-scroll"><div class="bloom-block-track"></div></div>` +
            // The density strip sits BELOW the block strip, reading as its
            // scrollbar (the viewport box is the thumb); the readout rides with it.
            `<div class="bloom-strip-wrap"></div>` +
            `<div class="bloom-probe-note"></div>`;
        const input = section.querySelector<HTMLInputElement>('.bloom-probe-value')!;
        const probeBtn = section.querySelector<HTMLButtonElement>('.bloom-probe-btn')!;
        const clearBtn = section.querySelector<HTMLButtonElement>('.bloom-probe-clear')!;
        const status = section.querySelector<HTMLElement>('.bloom-probe-status')!;
        const stripWrap = section.querySelector<HTMLElement>('.bloom-strip-wrap')!;
        const scroll = section.querySelector<HTMLElement>('.bloom-scroll')!;
        const track = section.querySelector<HTMLElement>('.bloom-block-track')!;
        const note = section.querySelector<HTMLElement>('.bloom-probe-note')!;

        // Fixed geometry: a block grid is 32*(CELL+1)-1 px wide; SLOT_W adds the
        // gap so block i sits at left = i*SLOT_W; SLOT_H bounds the track height.
        // BATCH is blocks per lazy range fetch; BUFFER over-renders each side of
        // the viewport so a scroll reveals ready grids.
        const CELL = 11;
        const BLOCK_W = 32 * (CELL + 1) - 1;
        const GAP = 12;
        const SLOT_W = BLOCK_W + GAP;
        const SLOT_H = 8 * (CELL + 1) - 1 + 23;
        const BATCH = 32;
        const BUFFER = 4;

        // Closure state: the fetched density, the last probe (null until probed),
        // a cache of fetched block bytes, the batch-start of each in-flight fetch
        // (dedupe), the currently-mounted window (so we re-render only on change),
        // and the strip's <svg>/viewport-box refs (repositioned on scroll).
        let density: BloomDensityResult | null = null;
        let probe: BloomProbeResult | null = null;
        const blockCache = new Map<number, Uint8Array>();
        const inflight = new Set<number>();
        let renderedStart = -1;
        let renderedEnd = -1;
        let stripSvg: SVGSVGElement | null = null;
        let viewportRect: SVGRectElement | null = null;

        // A block's 32 bytes, or null when not yet available: the probed block
        // reads straight from the probe result; any other from the cache.
        const bytesFor = (block: number): Uint8Array | null => {
            if (probe && block === probe.blockIndex) {
                return base64Bytes(probe.block) ?? null;
            }
            return blockCache.get(block) ?? null;
        };
        const probeBits = (block: number): BloomProbeBit[] | undefined =>
            probe && block === probe.blockIndex ? probe.bits : undefined;

        // Paint a mounted slot in place (label + grid, hit/miss if probed); a
        // no-op when the block isn't in the current window.
        const fillSlot = (block: number): void => {
            const el = track.querySelector<HTMLElement>(`.bloom-block-cell[data-block="${block}"]`);
            if (el) {
                el.innerHTML = blockCellInner(block, bytesFor(block), CELL, probeBits(block));
            }
        };

        // Ensure `block`'s bytes are (being) fetched: one range read per aligned
        // BATCH, deduped by batch-start, filling each mounted slot as bytes land.
        const ensureFetched = (block: number): void => {
            if (!this.bloomBlocks || !density || bytesFor(block)) {
                return;
            }
            const start = Math.floor(block / BATCH) * BATCH;
            if (inflight.has(start)) {
                return;
            }
            inflight.add(start);
            const count = Math.min(BATCH, density.numBlocks - start);
            this.bloomBlocks(node.rowGroup, node.path, start, count).then(
                b64 => {
                    inflight.delete(start);
                    const decoded = base64Bytes(b64);
                    if (!decoded) {
                        return;
                    }
                    for (let i = 0; i * 32 < decoded.length; i++) {
                        blockCache.set(start + i, decoded.subarray(i * 32, i * 32 + 32));
                        fillSlot(start + i);
                    }
                },
                (error: unknown) => {
                    inflight.delete(start);
                    if (isIncrementalReadError(error) && this.recovery.downloadFullFile) {
                        appendRecovery(
                            note,
                            RANGE_UNSUPPORTED_MESSAGE,
                            'Download full file',
                            this.recovery.downloadFullFile
                        );
                        return;
                    }
                    const message = (error as Error).message.trim();
                    note.textContent = `Blocks unavailable: ${message.split('\n').pop()!}`;
                }
            );
        };

        // The fixed-height status area: an explanatory hint until a probe lands,
        // then the value→hash→block lineage and the verdict. Same reserved height
        // both ways, so revealing the result never shifts layout.
        const renderStatus = (): void => {
            if (!probe) {
                status.innerHTML =
                    `<p class="bloom-probe-hint">A bloom filter can rule a value ` +
                    `<em>out</em> of this row group. Type a value and Probe: the filter ` +
                    `answers <strong>definitely not present</strong> — the reader safely ` +
                    `skips the whole row group — or <strong>maybe present</strong>, which ` +
                    `it can't rule out (bloom filters never give a false negative, only ` +
                    `false positives). The block it hashes to lights up below.</p>`;
                return;
            }
            status.innerHTML =
                renderBloomLineage(probe) +
                `<div class="bloom-verdict bloom-verdict-${probe.mightContain ? 'maybe' : 'no'}">` +
                (probe.mightContain
                    ? '<strong>maybe present</strong> — a bloom filter can only ever ' +
                      'answer “definitely not” or “maybe”; this could be a false positive.'
                    : '<strong>definitely not present</strong> — the filter has no false ' +
                      'negatives, so a reader can safely skip this row group.') +
                `</div>`;
        };
        renderStatus();

        // Position the minimap's viewport box to mirror the visible window: the
        // box spans [scrollLeft, scrollLeft+clientWidth] as a fraction of the full
        // content, mapped into the strip's own coordinate width.
        const syncViewport = (): void => {
            if (!stripSvg || !viewportRect) {
                return;
            }
            const vbW = Number(stripSvg.getAttribute('width'));
            const full = scroll.scrollWidth;
            const view = scroll.clientWidth;
            const x = full > 0 ? (scroll.scrollLeft / full) * vbW : 0;
            const w = full > 0 ? Math.min(1, view / full) * vbW : vbW;
            viewportRect.setAttribute('x', x.toFixed(2));
            viewportRect.setAttribute('width', w.toFixed(2));
        };

        // Mount only the blocks in view (± BUFFER), absolutely placed in the
        // full-width track, re-rendering just on window change; each mounted
        // block kicks off its lazy fetch.
        const renderWindow = (): void => {
            if (!density) {
                return;
            }
            const first = Math.max(0, Math.floor(scroll.scrollLeft / SLOT_W) - BUFFER);
            const last = Math.min(
                density.numBlocks,
                Math.ceil((scroll.scrollLeft + scroll.clientWidth) / SLOT_W) + BUFFER
            );
            if (first === renderedStart && last === renderedEnd) {
                return;
            }
            renderedStart = first;
            renderedEnd = last;
            const cells: string[] = [];
            for (let i = first; i < last; i++) {
                cells.push(
                    `<div class="bloom-block-cell" data-block="${i}" style="left:${i * SLOT_W}px">` +
                        `${blockCellInner(i, bytesFor(i), CELL, probeBits(i))}</div>`
                );
            }
            track.innerHTML = cells.join('');
            for (let i = first; i < last; i++) {
                ensureFetched(i);
            }
        };

        // Force the next renderWindow to rebuild (probe/clear changed the marks).
        const invalidate = (): void => {
            renderedStart = -1;
            renderedEnd = -1;
        };

        const onScroll = (): void => {
            renderWindow();
            syncViewport();
        };

        // Re-draw the overview strip (optionally marking the probed block) and
        // re-acquire the <svg>/box refs the strip owns, then reposition the box.
        const drawStrip = (probedBlock?: number): void => {
            if (!density) {
                return;
            }
            stripWrap.innerHTML = renderBloomStrip(density, probedBlock);
            stripSvg = stripWrap.querySelector<SVGSVGElement>('svg.bloom-strip');
            viewportRect = stripWrap.querySelector<SVGRectElement>('.bloom-strip-viewport');
            syncViewport();
        };

        // Scroll so `block` sits centered (browser clamps to the scroll range).
        const scrollToBlock = (block: number): void => {
            scroll.scrollLeft = block * SLOT_W - (scroll.clientWidth - BLOCK_W) / 2;
        };

        // The strip is the scrollbar: map a pointer x to a centered scroll pos.
        const scrubTo = (clientX: number): void => {
            if (!stripSvg) {
                return;
            }
            const rect = stripSvg.getBoundingClientRect();
            const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
            scroll.scrollLeft = frac * scroll.scrollWidth - scroll.clientWidth / 2;
            onScroll();
        };

        // Fetch the whole filter's density once, size the virtual track, draw the
        // strip, and mount the first window. A ResizeObserver re-virtualizes (and
        // repositions the box) when the card width changes.
        if (this.bloomDensity) {
            stripWrap.textContent = 'Loading filter…';
            this.bloomDensity(node.rowGroup, node.path).then(
                d => {
                    density = d;
                    track.style.width = `${d.numBlocks * SLOT_W - GAP}px`;
                    track.style.height = `${SLOT_H}px`;
                    drawStrip();
                    onScroll();
                    this.teardownBloom();
                    this.bloomResizeObserver = new ResizeObserver(onScroll);
                    this.bloomResizeObserver.observe(scroll);
                },
                (error: unknown) => {
                    if (isIncrementalReadError(error) && this.recovery.downloadFullFile) {
                        appendRecovery(
                            stripWrap,
                            RANGE_UNSUPPORTED_MESSAGE,
                            'Download full file',
                            this.recovery.downloadFullFile
                        );
                        return;
                    }
                    const message = (error as Error).message.trim();
                    stripWrap.textContent = `Filter unavailable: ${message.split('\n').pop()!}`;
                }
            );
        }

        scroll.addEventListener('scroll', onScroll);

        // Press/drag anywhere on the strip to scrub the block strip (the box is
        // pointer-transparent, so drags fall through to the density cells).
        let dragging = false;
        stripWrap.addEventListener('pointerdown', e => {
            if (!density) {
                return;
            }
            dragging = true;
            stripWrap.setPointerCapture(e.pointerId);
            scrubTo(e.clientX);
        });
        stripWrap.addEventListener('pointermove', e => {
            if (dragging) {
                scrubTo(e.clientX);
            }
        });
        const endDrag = (e: PointerEvent): void => {
            if (dragging) {
                dragging = false;
                stripWrap.releasePointerCapture(e.pointerId);
            }
        };
        stripWrap.addEventListener('pointerup', endDrag);
        stripWrap.addEventListener('pointercancel', endDrag);

        const run = (): void => {
            note.textContent = '';
            // Binary columns take base64 of the raw bytes; validate it decodes,
            // then send the trimmed base64 (the worker decodes it back to bytes).
            // Everything else parses as its typed value, same as the query panel.
            let value: string | undefined;
            if (binary) {
                const trimmed = input.value.trim();
                value = base64Bytes(trimmed) ? trimmed : undefined;
            } else {
                const parsed = leaf ? parsePredicateValue(input.value, leaf) : undefined;
                value = parsed === undefined ? undefined : String(parsed);
            }
            if (value === undefined) {
                note.textContent = leaf
                    ? `'${input.value}' is not a valid ${leaf.type} value${
                          binary ? ' (expected base64)' : ''
                      }`
                    : `column '${node.path}' was not found in the schema`;
                return;
            }
            note.textContent = 'Probing...';
            this.bloomProbe!(node.rowGroup, node.path, value).then(
                res => {
                    probe = res;
                    note.textContent = '';
                    clearBtn.disabled = false;
                    renderStatus();
                    // Re-mark the strip, scroll the probed block into view, and
                    // force the window to rebuild with its hit/miss overlay.
                    drawStrip(res.blockIndex);
                    scrollToBlock(res.blockIndex);
                    invalidate();
                    onScroll();
                },
                (error: unknown) => {
                    if (isIncrementalReadError(error) && this.recovery.downloadFullFile) {
                        appendRecovery(
                            note,
                            RANGE_UNSUPPORTED_MESSAGE,
                            'Download full file',
                            this.recovery.downloadFullFile
                        );
                        return;
                    }
                    // Pyodide errors embed the python traceback; the last line
                    // is the actual exception.
                    const message = (error as Error).message.trim();
                    note.textContent = `Probe failed: ${message.split('\n').pop()!}`;
                }
            );
        };
        probeBtn.addEventListener('click', run);
        clearBtn.addEventListener('click', () => {
            // Drop the probe overlay: unmark the strip and rebuild the window so
            // the previously-probed block repaints without its marks (fetching
            // its real bytes if they weren't cached).
            probe = null;
            clearBtn.disabled = true;
            note.textContent = '';
            renderStatus();
            drawStrip();
            invalidate();
            onScroll();
        });
        input.addEventListener('keypress', e => {
            if ((e as KeyboardEvent).key === 'Enter') {
                run();
            }
        });
        return section;
    }

    hide(): void {
        this.teardownBloom();
        this.infoPanel.style.display = 'none';
    }

    /** Disconnect the open bloom section's ResizeObserver, if any. Called before
     *  the panel is re-rendered or hidden so an observer never outlives its
     *  block strip. */
    private teardownBloom(): void {
        this.bloomResizeObserver?.disconnect();
        this.bloomResizeObserver = null;
    }

    private renderSection(section: Section): string {
        const body =
            section.html ??
            `<div class="info-grid">${(section.rows ?? [])
                .map(([label, value, copy]) => {
                    const btn =
                        copy === undefined
                            ? ''
                            : typeof copy === 'string'
                              ? copyButton(copy)
                              : 'wkb' in copy
                                ? // GeoJSON (⧉) + raw base64 WKB for the probe (#).
                                  copyGeoJsonButton(copy.wkb) + copyPhysicalButton(copy.wkb)
                                : copyPhysicalButton(copy.physical);
                    return (
                        `<div class="info-item"><span class="info-label">${escapeHtml(String(label))}:</span>` +
                        `<span class="info-value">${escapeHtml(String(value))}${btn}</span></div>`
                    );
                })
                .join('')}</div>`;
        const card = section.html ? 'large-card' : 'regular-card';
        const recovery =
            section.degraded === 'metadata-only' && this.recovery.loadFullStructure
                ? `<button type="button" class="btn recovery-btn" data-action="upgrade">Load full structure from source</button>`
                : '';
        return `<div class="info-section ${card}"><h5 class="info-section-title">${section.title}</h5>${body}${recovery}</div>`;
    }
}
