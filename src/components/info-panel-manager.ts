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
import { base64Bytes } from '../business/stat-values';
import { wkbToGeoJson } from '../business/wkb';
import type {
    BloomDensityResult,
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
    isIncrementalReadError,
    appendRecovery,
    RANGE_UNSUPPORTED_MESSAGE,
} from './info-panel/recovery';
import type { RecoveryActions } from './info-panel/recovery';
import { createBloomProbeWidget, type BloomProbeWidget } from './info-panel/bloom-probe-widget';
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
    /** The open bloom-probe widget, if any. It owns a ResizeObserver over its
     *  block strip; destroy()ed whenever the panel is re-shown or hidden so the
     *  observer never outlives its strip (no leak). */
    private bloomWidget: BloomProbeWidget | null = null;

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
            this.bloomWidget = createBloomProbeWidget(node, dump, {
                bloomProbe: this.bloomProbe,
                bloomDensity: this.bloomDensity,
                bloomBlocks: this.bloomBlocks,
                recovery: this.recovery,
            });
            this.infoPanel.querySelector('.info-sections')!.appendChild(this.bloomWidget.element);
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

    hide(): void {
        this.teardownBloom();
        this.infoPanel.style.display = 'none';
    }

    /** Destroy the open bloom-probe widget (disconnecting its ResizeObserver),
     *  if any. Called before the panel is re-rendered or hidden so the observer
     *  never outlives its block strip. */
    private teardownBloom(): void {
        this.bloomWidget?.destroy();
        this.bloomWidget = null;
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
