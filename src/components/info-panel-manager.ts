/**
 * Info Panel Manager
 *
 * One declarative registry maps each segment `kind` to the sections it shows.
 * A single renderer turns sections into HTML. No per-kind generate* methods, no
 * shape-sniffing dispatch — the node's kind already says what it is.
 */
import { formatBytes, formatNumber, formatOffset } from '../format';
import { logicalTypeLabel } from '../domain/parquet-type-resolver';
import {
    columnDisplayType,
    geoparquetColumns,
    isWkbColumn,
    type GeoColumn,
} from '../domain/geoparquet';
import { OP_LABEL } from '../business/pruning';
import type { Resolution } from '../business/query-model';
import {
    describe,
    findSchemaLeaf,
    isSet,
    type Kind,
    type SegmentNode,
} from '../business/segment-tree';
import {
    base64Bytes,
    decodeStatValue,
    formatStatValue,
    isBinaryLeaf,
    parsePredicateValue,
} from '../business/stat-values';
import { describeWkb, wkbToGeoJson } from '../business/wkb';
import type {
    BloomDensityResult,
    BloomProbeBit,
    BloomProbeResult,
    DictionaryEntry,
    DictionaryPreviewResult,
    PreviewEntry,
    PreviewResult,
    PreviewValue,
} from '../js/worker/pyodide-parquet';
import type {
    AnyDump,
    ColumnMetadata,
    ColumnStatistics,
    SchemaGroup,
    SchemaLeaf,
    SchemaRoot,
} from '../types';

/** A metadata-only export lacks the physical `column_chunks` array. */
function isMetadataOnly(dump: AnyDump): boolean {
    return !('column_chunks' in dump);
}

/** Column-chunk count from either root (physical array or footer row groups). */
function columnChunkCount(dump: AnyDump): number {
    if ('column_chunks' in dump) {
        return dump.column_chunks.length;
    }
    return dump.metadata.row_groups.reduce((n, g) => n + Object.keys(g.column_chunks).length, 0);
}

const METADATA_ONLY_NOTE =
    'Page detail is not in a metadata-only dump — load the original .parquet to see pages.';

const BLOOM_PROBE_UNAVAILABLE_NOTE =
    'Probing needs the filter bytes — load the original .parquet to test values.';

const VALUE_PREVIEW_UNAVAILABLE_NOTE =
    'Decoding values needs the file bytes — load the original .parquet to preview values.';

const RANGE_UNSUPPORTED_MESSAGE =
    "This file can't be read incrementally (HTTP range requests not supported).";

/** True when a byte read failed because the server won't serve range requests. */
export function isIncrementalReadError(error: unknown): boolean {
    const message = (error as Error | undefined)?.message ?? '';
    return (
        message.includes('HctefNetworkError') ||
        message.includes('does not support HTTP range') ||
        message.includes('range request')
    );
}

/**
 * Recovery actions for degraded cards: re-parse the file from its URL to gain
 * full structure (metadata-only dumps), or download the whole file when the
 * server won't serve range requests. Null when the loaded dump has no fetchable
 * source (no recovery possible).
 */
export interface RecoveryActions {
    loadFullStructure: (() => void) | null;
    downloadFullFile: (() => void) | null;
}

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
 * Reads one 256-bit block's 32 raw bytes (base64) from a column chunk's bloom
 * filter, so any block's bit-grid renders on demand at any filter size. Same
 * lifecycle as BloomDensity.
 */
export type BloomBlock = (rowGroup: number, column: string, blockIndex: number) => Promise<string>;

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

/** Long values are cut with an ellipsis in the preview list. */
const PREVIEW_VALUE_MAX_CHARS = 80;

/** Values shown per preview page; the worker decodes the whole page once. */
const PREVIEW_PAGE_SIZE = 100;

/** Where a value preview points: a data page's coordinates in the worker's file. */
interface PreviewTarget {
    rowGroup: number;
    column: string;
    pageIndex: number;
}

/** Friendly (not an error state) message for a codec with no in-browser decoder. */
function renderPreviewFailure(codec: string): string {
    const name = escapeHtml(codec);
    return (
        `<div class="value-preview-codec-note">This chunk is ${name}-compressed and ` +
        `${name.toLowerCase()} can't be decoded in-browser.</div>`
    );
}

/**
 * A 256-bit block as an 8×32 bit grid (rows = words, columns = bits) from its
 * raw 32 bytes. When `probed` is given (the block the probe landed in, being
 * viewed), the eight checked bits are marked hit (set) or miss (unset); every
 * other cell shows the block's actual contents dimly for texture. All hits ⟹
 * "might contain"; a single miss is exact proof of absence. Viewing a different
 * block (no `probed`) shows its plain bits.
 */
function renderBloomBlock(bytes: Uint8Array, probed?: BloomProbeBit[]): string {
    if (bytes.length < 32) {
        return '';
    }
    const probedBit = new Map((probed ?? []).map(b => [b.word, b.bit]));
    const CELL = 11;
    const STEP = CELL + 1;
    const width = 32 * STEP - 1;
    const height = 8 * STEP - 1;
    let cells = '';
    for (let word = 0; word < 8; word++) {
        // Each word is a little-endian uint32; bit `col` is (word >> col) & 1.
        const value =
            (bytes[word * 4]! |
                (bytes[word * 4 + 1]! << 8) |
                (bytes[word * 4 + 2]! << 16) |
                (bytes[word * 4 + 3]! << 24)) >>>
            0;
        for (let col = 0; col < 32; col++) {
            const set = (value >>> col) & 1;
            const cls =
                probedBit.get(word) === col
                    ? set
                        ? 'bloom-bit-hit'
                        : 'bloom-bit-miss'
                    : set
                      ? 'bloom-bit-on'
                      : 'bloom-bit-off';
            cells +=
                `<rect class="${cls}" x="${col * STEP}" y="${word * STEP}" ` +
                `width="${CELL}" height="${CELL}" rx="1"/>`;
        }
    }
    return (
        `<svg class="bloom-block" viewBox="0 0 ${width} ${height}" width="${width}" ` +
        `height="${height}" role="img" aria-label="bloom-filter block">${cells}</svg>`
    );
}

/** The value → hash → block lineage line shown above the probed block's grid. */
function renderBloomLineage(res: BloomProbeResult): string {
    const hits = res.bits.filter(b => b.set).length;
    return (
        `<div class="bloom-lineage">hash <code>0x${res.hash}</code> → block ` +
        `${formatNumber(res.blockIndex)} of ${formatNumber(res.numBlocks)} · ${hits}/8 bits set` +
        `</div>`
    );
}

/** Estimated false-positive rate as a human `~X% est.` label. A split-block
 *  bloom filter checks 8 bits, so p(all set at random) ≈ fill**8; tiny values
 *  read as exponential rather than a wall of zeros, and 0 fill reads `~0%`. */
function estimatedFprLabel(fill: number): string {
    const fpr = fill ** 8;
    if (fpr <= 0) {
        return '~0%';
    }
    const pct = fpr * 100;
    const shown = pct < 0.001 ? `${pct.toExponential(1)}` : `${pct.toPrecision(2)}`;
    return `~${shown}%`;
}

/** The first block a strip cell maps to: cell index directly when one cell is
 *  one block (≤512), else the first block of the cell's contiguous bucket. */
function cellBlock(density: BloomDensityResult, cell: number): number {
    const n = density.buckets.length;
    return density.numBlocks <= n ? cell : Math.floor((cell * density.numBlocks) / n);
}

/**
 * The whole filter as a horizontal density heatmap: one clickable rect per
 * bucket, filled by its set-bit fraction over a light track (empty reads empty).
 * Each cell carries `data-block` (see cellBlock); the cells whose block is the
 * `selected` / `probed` block get an inset outline (via CSS classes). A one-line
 * readout pairs the overall fill %, the block count, and the estimated FPR.
 */
function renderBloomStrip(
    density: BloomDensityResult,
    selectedBlock: number,
    probedBlock?: number
): string {
    const { buckets, fill, numBlocks } = density;
    const n = buckets.length;
    if (n === 0) {
        return `<div class="bloom-strip-readout">empty filter — 0 blocks</div>`;
    }
    const CELL = Math.max(1, Math.floor(512 / n));
    const height = 24;
    const width = n * CELL;
    const rects = buckets
        .map((b, i) => {
            const block = cellBlock(density, i);
            const marks =
                (block === selectedBlock ? ' selected' : '') +
                (probedBlock !== undefined && block === probedBlock ? ' probed' : '');
            // Density carries as fill-opacity on the accent-filled cell (CSS
            // var() doesn't resolve in an SVG presentation attribute, so the
            // color lives in the class and only the opacity is inline); clamp so
            // a faint but non-empty bucket still reads as set.
            const alpha = b === 0 ? 0 : Math.max(0.08, b);
            return (
                `<rect class="bloom-strip-cell${marks}" data-block="${block}" ` +
                `x="${i * CELL}" y="0" width="${CELL}" height="${height}" ` +
                `fill-opacity="${alpha.toFixed(3)}"/>`
            );
        })
        .join('');
    const readout =
        `<div class="bloom-strip-readout">` +
        `<span>${(fill * 100).toFixed(1)}% full;</span>` +
        `<span>${formatNumber(numBlocks)} block${numBlocks === 1 ? '' : 's'};</span>` +
        `<span title="estimated false-positive rate (fill^8)">estimated false-positive rate ${estimatedFprLabel(fill)}</span>` +
        `</div>`;
    return (
        `<svg class="bloom-strip" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
        `preserveAspectRatio="none" role="img" aria-label="bloom-filter density">` +
        `<rect class="bloom-strip-track" x="0" y="0" width="${width}" height="${height}"/>${rects}</svg>` +
        readout
    );
}

/**
 * A single value cell: NULL is explicit; long values ellipsize with a copy
 * button for the full value. A GEOMETRY/GEOGRAPHY cell (raw WKB as base64) is
 * shown as a summary with a copy button that yields the full GeoJSON geometry;
 * WKB that won't parse falls back to the plain-string path (never mangled). When
 * a `physical` value is given (a logical column displays a converted value), a
 * second button copies the raw physical value the bloom probe hashes.
 */
function previewValueCell(value: PreviewValue, isWkb = false, physical?: PreviewValue): string {
    if (value === null) {
        return '<span class="value-preview-null">NULL</span>';
    }
    if (isWkb && typeof value === 'string') {
        const bytes = base64Bytes(value);
        const summary = bytes && describeWkb(bytes);
        if (summary) {
            // Carry the base64 WKB, not the GeoJSON; convert on click (see button).
            // GeoJSON (⧉) = the converted geometry; physical (#) = the raw base64
            // WKB the bloom probe hashes.
            return escapeHtml(summary) + copyGeoJsonButton(value) + copyPhysicalButton(value);
        }
    }
    const physicalBtn =
        physical === undefined || physical === null ? '' : copyPhysicalButton(String(physical));
    const s = String(value);
    if (s.length > PREVIEW_VALUE_MAX_CHARS) {
        return (
            escapeHtml(`${s.slice(0, PREVIEW_VALUE_MAX_CHARS - 1)}…`) + copyButton(s) + physicalBtn
        );
    }
    return escapeHtml(s) + physicalBtn;
}

/** tbody rows; `#` is each value's own absolute page index (sparse under null-skip). */
function renderPreviewRows(entries: PreviewEntry[], isWkb: boolean): string {
    return entries
        .map(
            entry =>
                `<tr><td class="value-preview-index">${entry.index}</td>` +
                `<td class="value-preview-value">${previewValueCell(entry.value, isWkb, entry.physical)}</td>` +
                `<td class="value-preview-level">${entry.def}</td>` +
                `<td class="value-preview-level">${entry.rep}</td></tr>`
        )
        .join('');
}

/** One rendered window plus the controls that drive it. */
interface PreviewWindowView {
    entries: PreviewEntry[];
    /** Value index this window's span starts at (the requested offset). */
    start: number;
    /** Value index the next window starts at (one past this span). */
    next: number;
    total: number;
    nulls: number;
    hideNulls: boolean;
    canPrev: boolean;
    /** Column is WKB geometry: cells show a summary + copy-as-GeoJSON. */
    isWkb: boolean;
    onToggleNulls: (hide: boolean) => void;
    onPrev: () => void;
    onNext: () => void;
}

/** "1–100 of 5,000 values" window-range label (empty page reads "0 values"). */
function previewRange(start: number, next: number, total: number): string {
    return total === 0
        ? '0 values'
        : `${formatNumber(start + 1)}–${formatNumber(next)} of ${formatNumber(total)} ` +
              `value${total === 1 ? '' : 's'}`;
}

/** Prev/Next pager buttons, or '' when neither direction is available. */
function pagerButtons(canPrev: boolean, canNext: boolean): string {
    if (!canPrev && !canNext) {
        return '';
    }
    return (
        `<div class="value-preview-buttons">` +
        `<button type="button" class="btn btn-sm value-preview-prev"${canPrev ? '' : ' disabled'}>‹ Prev</button>` +
        `<button type="button" class="btn btn-sm value-preview-next"${canNext ? '' : ' disabled'}>Next ›</button></div>`
    );
}

/**
 * Fills `result` with one window of a page's values (scrollable table, frozen
 * header, zebra rows) and a footer that pairs the range/count text and the
 * "hide nulls" toggle with the prev/next pager. Callers keep the current table
 * in place until this swaps it in, so paging never flashes. The range spans the
 * value indices this window consumed (`start`..`next`), which under null-skip
 * can be far wider than the handful of rows shown.
 */
function renderPreviewWindow(result: HTMLElement, view: PreviewWindowView): void {
    const { entries, start, next, total, nulls, hideNulls } = view;
    const range = previewRange(start, next, total);
    const info = nulls > 0 ? `${range} · ${formatNumber(nulls)} null` : range;
    const toggle =
        nulls > 0
            ? `<label class="value-preview-filter">` +
              `<input type="checkbox" class="value-preview-hide-nulls"${hideNulls ? ' checked' : ''}> ` +
              `hide nulls</label>`
            : '';
    result.innerHTML =
        `<div class="value-preview-table-wrap"><table class="value-preview-table">` +
        `<thead><tr><th>#</th><th>Value</th><th title="definition level">def</th>` +
        `<th title="repetition level">rep</th></tr></thead>` +
        `<tbody>${renderPreviewRows(entries, view.isWkb)}</tbody></table></div>` +
        `<div class="value-preview-pager">` +
        `<div class="value-preview-info"><span class="value-preview-range">${info}</span>${toggle}</div>` +
        `${pagerButtons(view.canPrev, next < total)}</div>`;
    result
        .querySelector<HTMLInputElement>('.value-preview-hide-nulls')
        ?.addEventListener('change', e =>
            view.onToggleNulls((e.target as HTMLInputElement).checked)
        );
    result.querySelector('.value-preview-prev')?.addEventListener('click', () => view.onPrev());
    result.querySelector('.value-preview-next')?.addEventListener('click', () => view.onNext());
}

/**
 * One window of dictionary entries as a `# | Value` table with a pager. Simpler
 * than renderPreviewWindow: a dictionary has no def/rep levels and no nulls, so
 * no level columns and no hide-nulls toggle, and paging is plain arithmetic.
 */
function renderDictionaryWindow(
    result: HTMLElement,
    view: {
        entries: DictionaryEntry[];
        start: number;
        next: number;
        total: number;
        canPrev: boolean;
        isWkb: boolean;
        onPrev: () => void;
        onNext: () => void;
    }
): void {
    const rows = view.entries
        .map(
            e =>
                `<tr><td class="value-preview-index">${e.index}</td>` +
                `<td class="value-preview-value">${previewValueCell(e.value, view.isWkb)}</td></tr>`
        )
        .join('');
    result.innerHTML =
        `<div class="value-preview-table-wrap"><table class="value-preview-table">` +
        `<thead><tr><th>#</th><th>Value</th></tr></thead>` +
        `<tbody>${rows}</tbody></table></div>` +
        `<div class="value-preview-pager">` +
        `<div class="value-preview-info"><span class="value-preview-range">` +
        `${previewRange(view.start, view.next, view.total)}</span></div>` +
        `${pagerButtons(view.canPrev, view.next < view.total)}</div>`;
    result.querySelector('.value-preview-prev')?.addEventListener('click', () => view.onPrev());
    result.querySelector('.value-preview-next')?.addEventListener('click', () => view.onNext());
}

/** A label/value row. An optional third element is a copy payload: a plain
 *  string (the full value, when truncated), `{ wkb }` base64 to copy as GeoJSON
 *  (converted lazily on click), or `{ physical }` — the raw physical value a
 *  logical column displays converted, for pasting into the bloom probe. */
type Row =
    | [string, string | number]
    | [string, string | number, string]
    | [string, string | number, { wkb: string }]
    | [string, string | number, { physical: string }];

/** A copy-to-clipboard button carrying the full (untruncated) value. `glyph` is
 *  a trusted literal (the button face), never user input. */
function copyButton(full: string, label = 'Copy full value', glyph = '⧉'): string {
    return (
        `<button type="button" class="copy-btn" data-copy="${escapeHtml(full)}"` +
        ` title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${glyph}</button>`
    );
}

/** Copy button for the raw physical value a logical column displays converted
 *  (a temporal type's int, ...) — the value the bloom probe hashes. `#` sets it
 *  apart from the `⧉` value/GeoJSON copies at a glance. */
function copyPhysicalButton(value: string): string {
    return copyButton(value, 'Copy physical value', '#');
}

/**
 * Copy button that holds base64 WKB and converts it to GeoJSON on click. A
 * preview page can hold 100 large geometries, so embedding each one's GeoJSON
 * up front would put megabytes in the DOM; convert lazily instead.
 */
function copyGeoJsonButton(base64Wkb: string): string {
    return (
        `<button type="button" class="copy-btn" data-copy-wkb="${escapeHtml(base64Wkb)}"` +
        ` title="Copy as GeoJSON" aria-label="Copy as GeoJSON">⧉</button>`
    );
}

/** Truncate for display, returning `[shown, full]` where full is set only when clipped. */
function truncateCopy(full: string, max: number): [string, string?] {
    return full.length > max ? [`${full.slice(0, max - 3)}...`, full] : [full];
}
interface Section {
    title: string;
    rows?: Row[];
    html?: string;
    degraded?: 'metadata-only';
}

type Handler<K extends Kind> = (
    node: Extract<SegmentNode, { kind: K }>,
    dump: AnyDump
) => Section[];
type Registry = { [K in Kind]: Handler<K> };

/** Standard Start/End/Size section every physical segment shows. */
function layout(node: SegmentNode): Section {
    return {
        title: 'Physical Layout',
        rows: [
            ['Start Offset', formatOffset(node.start)],
            ['End Offset', formatOffset(node.end)],
            ['Size', formatBytes(node.end - node.start)],
        ],
    };
}

function ratio(compressed: number, uncompressed: number): string {
    return uncompressed > 0 ? `${((compressed / uncompressed) * 100).toFixed(1)}%` : 'N/A';
}

function countColumns(node: SchemaRoot | SchemaGroup | SchemaLeaf): number {
    const children = 'children' in node ? node.children : undefined;
    if (!children) {
        return node.element_type === 'group' || node.element_type === 'root' ? 0 : 1;
    }
    return Object.values(children).reduce((sum, c) => sum + countColumns(c), 0);
}

/** X/Y (+ optional Z/M) range rows from a normalized bounding box. */
function bboxRows(b: {
    xmin?: number | null;
    xmax?: number | null;
    ymin?: number | null;
    ymax?: number | null;
    zmin?: number | null;
    zmax?: number | null;
    mmin?: number | null;
    mmax?: number | null;
}): Row[] {
    const rows: Row[] = [
        ['X Range', `${b.xmin} … ${b.xmax}`],
        ['Y Range', `${b.ymin} … ${b.ymax}`],
    ];
    if (isSet(b.zmin) && isSet(b.zmax)) {
        rows.push(['Z Range', `${b.zmin} … ${b.zmax}`]);
    }
    if (isSet(b.mmin) && isSet(b.mmax)) {
        rows.push(['M Range', `${b.mmin} … ${b.mmax}`]);
    }
    return rows;
}

/** Bounding box + geometry-type inventory for GEOMETRY/GEOGRAPHY columns. */
function geospatialRows(gs: NonNullable<ColumnMetadata['geospatial_statistics']>): Row[] {
    const rows: Row[] = gs.bbox ? bboxRows(gs.bbox) : [];
    if (gs.geospatial_types?.length) {
        rows.push(['Geometry Types', gs.geospatial_types.join(', ')]);
    }
    return rows;
}

/** Bounding-box + geometry-type rows from a GeoParquet column entry. */
function geoparquetRows(g: GeoColumn): Row[] {
    const b = g.bbox;
    // GeoParquet packs the bbox positionally: [xmin,ymin,xmax,ymax] (2D) or
    // [xmin,ymin,zmin,xmax,ymax,zmax] (3D). Normalize to the named shape.
    const rows: Row[] =
        b?.length === 4
            ? bboxRows({ xmin: b[0], ymin: b[1], xmax: b[2], ymax: b[3] })
            : b?.length === 6
              ? bboxRows({ xmin: b[0], ymin: b[1], zmin: b[2], xmax: b[3], ymax: b[4], zmax: b[5] })
              : [];
    if (g.geometry_types?.length) {
        rows.push(['Geometry Types', g.geometry_types.join(', ')]);
    }
    if (g.encoding) {
        rows.push(['Encoding', `${g.encoding} (GeoParquet)`]);
    }
    return rows;
}

/** Per-level histograms + unencoded footprint from a column's size statistics. */
function sizeStatRows(ss: NonNullable<ColumnMetadata['size_statistics']>): Row[] {
    const rows: Row[] = [];
    if (isSet(ss.unencoded_byte_array_data_bytes)) {
        rows.push(['Unencoded Size', formatBytes(ss.unencoded_byte_array_data_bytes)]);
    }
    if (ss.definition_level_histogram?.length) {
        rows.push(['Definition Levels', `[${ss.definition_level_histogram.join(', ')}]`]);
    }
    if (ss.repetition_level_histogram?.length) {
        rows.push(['Repetition Levels', `[${ss.repetition_level_histogram.join(', ')}]`]);
    }
    return rows;
}

/** One "page-type · encoding → count" row per entry in the column's encoding stats. */
function encodingStatRows(es: NonNullable<ColumnMetadata['encoding_stats']>): Row[] {
    return es.map(s => [`${s.page_type} · ${s.encoding}`, formatNumber(s.count)]);
}

function statRows(stats: ColumnStatistics, leaf?: SchemaLeaf | null, wkb = false): Row[] {
    // min/max_value are base64 raw physical bytes; decode with the leaf's type
    // when we can, else fall back to the raw string (INT96/binary =
    // decodeStatValue returns undefined, matching the pruning engine's honesty).
    const cell = (label: string, v: string | null | undefined): Row => {
        if (v === null || v === undefined) {
            return [label, 'N/A'];
        }
        if (wkb) {
            // WKB min/max are geometries too: show the summary, copy full GeoJSON
            // (lazy — carry the base64, convert on click, same as the preview).
            const bytes = base64Bytes(v);
            const summary = bytes && describeWkb(bytes);
            if (summary) {
                return [label, summary, { wkb: v }];
            }
        }
        const full = (leaf ? formatStatValue(v, leaf) : undefined) ?? v;
        // A logical column (e.g. a temporal type) displays a converted value,
        // but the bloom probe hashes the raw physical value. When they differ,
        // offer the physical value for copy so it can be pasted into the probe.
        const physical = leaf ? decodeStatValue(v, leaf) : undefined;
        const physicalStr = physical === undefined ? undefined : String(physical);
        if (physicalStr !== undefined && physicalStr !== full) {
            return [label, full, { physical: physicalStr }];
        }
        // Binary columns (UUID, raw binary): the probe hashes base64 of the raw
        // bytes, and v IS that base64. Offer it when the display differs (UUID
        // shows hex; plain binary already shows the base64, so no redundant #).
        if (leaf && isBinaryLeaf(leaf) && v !== full) {
            return [label, full, { physical: v }];
        }
        const [shown, copy] = truncateCopy(full, 50);
        return copy === undefined ? [label, shown] : [label, shown, copy];
    };
    const rows: Row[] = [
        cell('Min Value', stats.min_value),
        cell('Max Value', stats.max_value),
        ['Null Count', stats.null_count === null ? 'N/A' : formatNumber(stats.null_count)],
        [
            'Distinct Count',
            stats.distinct_count === null || stats.distinct_count === undefined
                ? 'N/A'
                : formatNumber(stats.distinct_count),
        ],
    ];
    // Exact/estimated flags matter for trusting min/max after row skipping.
    if (isSet(stats.is_min_value_exact)) {
        rows.push(['Min Exact', stats.is_min_value_exact ? 'Yes' : 'No']);
    }
    if (isSet(stats.is_max_value_exact)) {
        rows.push(['Max Exact', stats.is_max_value_exact ? 'Yes' : 'No']);
    }
    return rows;
}

/**
 * Statistics + geospatial + size/encoding sections for a column's metadata.
 * Shared by the physical `column_chunk` view and the metadata-only `chunk_meta`
 * view so both decode WKB min/max and surface the same extents consistently.
 */
function columnMetaSections(
    meta: ColumnMetadata,
    leaf: SchemaLeaf | null | undefined,
    geo: GeoColumn | undefined
): Section[] {
    const sections: Section[] = [];
    if (meta.statistics) {
        sections.push({
            title: 'Statistics',
            rows: statRows(meta.statistics, leaf, isWkbColumn(leaf, geo)),
        });
    }
    // Prefer native geospatial_statistics; fall back to the file's `geo` block
    // (Overture writes GeoParquet metadata and no native stats). Never both, so
    // the panel can't show two "Geospatial Statistics" sections.
    const geoRows = meta.geospatial_statistics
        ? geospatialRows(meta.geospatial_statistics)
        : geo
          ? geoparquetRows(geo)
          : [];
    if (geoRows.length) {
        sections.push({ title: 'Geospatial Statistics', rows: geoRows });
    }
    if (meta.size_statistics) {
        const rows = sizeStatRows(meta.size_statistics);
        if (rows.length) {
            sections.push({ title: 'Size Statistics', rows });
        }
    }
    if (meta.encoding_stats?.length) {
        sections.push({ title: 'Encoding Stats', rows: encodingStatRows(meta.encoding_stats) });
    }
    return sections;
}

/** Aggregate page-type / encoding counts across all data pages (overview). */
function pageSummary(dump: AnyDump): Section[] {
    // A metadata-only export carries no page structure to summarize.
    if (!('column_chunks' in dump)) {
        return [
            {
                title: 'Data Pages',
                rows: [['Detail', METADATA_ONLY_NOTE]],
                degraded: 'metadata-only',
            },
        ];
    }
    if (dump.column_chunks.length === 0) {
        return [];
    }
    const pageTypes: Record<string, number> = {};
    const encodings: Record<string, number> = {};
    let total = 0;
    let bytes = 0;
    const bump = (m: Record<string, number>, k: string): void => {
        m[k] = (m[k] ?? 0) + 1;
    };
    for (const chunk of dump.column_chunks) {
        if (chunk.dictionary_page) {
            total++;
            bytes += chunk.dictionary_page.compressed_page_size;
            bump(pageTypes, 'DICTIONARY_PAGE');
            bump(encodings, chunk.dictionary_page.encoding);
        }
        for (const p of chunk.data_pages) {
            total++;
            bytes += p.compressed_page_size;
            bump(pageTypes, p.page_type ?? 'DATA_PAGE');
            bump(encodings, p.encoding);
        }
        for (const p of chunk.index_pages) {
            total++;
            bytes += p.compressed_page_size;
            bump(pageTypes, 'INDEX_PAGE');
        }
    }
    const pct = (n: number): string => (total > 0 ? ((n / total) * 100).toFixed(1) : '0.0');
    const sections: Section[] = [
        {
            title: 'Data Page Summary',
            rows: [
                ['Total Pages', formatNumber(total)],
                ['Average Page Size', formatBytes(total > 0 ? bytes / total : 0)],
            ],
        },
    ];
    const breakdown = (m: Record<string, number>): Row[] =>
        Object.entries(m).map(([k, n]) => [k, `${formatNumber(n)} (${pct(n)}%)`]);
    if (Object.keys(pageTypes).length > 0) {
        sections.push({ title: 'Page Types', rows: breakdown(pageTypes) });
    }
    if (Object.keys(encodings).length > 0) {
        sections.push({ title: 'Encodings', rows: breakdown(encodings) });
    }
    return sections;
}

// -- JSON value viewer (kept for key-value entries) --------------------------

export function escapeHtml(text: string): string {
    return text.replace(
        /[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
    );
}

function renderJson(obj: unknown, depth = 0): string {
    const indent = '  '.repeat(depth);
    if (Array.isArray(obj)) {
        if (obj.length === 0) {
            return '<span class="json-empty-array">[]</span>';
        }
        const items = obj
            .map(
                (item, i) =>
                    `${indent}  ${renderJson(item, depth + 1)}${i < obj.length - 1 ? '<span class="json-comma">,</span>' : ''}`
            )
            .join('<br>');
        return `<span class="json-bracket">[</span><br>${items}<br>${indent}<span class="json-bracket">]</span>`;
    }
    if (obj !== null && typeof obj === 'object') {
        const rec = obj as Record<string, unknown>;
        const keys = Object.keys(rec);
        if (keys.length === 0) {
            return '<span class="json-empty-object">{}</span>';
        }
        const items = keys
            .map(
                (k, i) =>
                    `${indent}  <span class="json-key">"${escapeHtml(k)}"</span><span class="json-colon">: </span>${renderJson(rec[k], depth + 1)}${i < keys.length - 1 ? '<span class="json-comma">,</span>' : ''}`
            )
            .join('<br>');
        return `<span class="json-bracket">{</span><br>${items}<br>${indent}<span class="json-bracket">}</span>`;
    }
    if (obj === null) {
        return '<span class="json-null">null</span>';
    }
    if (typeof obj === 'string') {
        return `<span class="json-string">"${escapeHtml(obj)}"</span>`;
    }
    return `<span class="json-${typeof obj}">${escapeHtml(String(obj))}</span>`;
}

function valueViewer(value: string): Section {
    try {
        const parsed: unknown = JSON.parse(value);
        if (parsed && typeof parsed === 'object') {
            return {
                title: 'Value (JSON)',
                html: `<div class="value-viewer json-viewer"><div class="json-tree">${renderJson(parsed)}</div></div>`,
            };
        }
    } catch {
        // not JSON; fall through to plain text
    }
    return {
        title: 'Value',
        html: `<div class="value-viewer code-viewer"><pre><code>${escapeHtml(value)}</code></pre></div>`,
    };
}

// -- The registry ------------------------------------------------------------

const PANELS: Registry = {
    file: (_node, dump) => {
        const m = dump.metadata;
        const sections: Section[] = [
            {
                title: 'File Information',
                rows: [
                    ['Source', dump.source],
                    ['Total Size', formatBytes(dump.filesize)],
                    ['Mode', isMetadataOnly(dump) ? 'Metadata-only export' : 'Full dump'],
                    ['Parquet Version', m.version],
                    ['Created By', m.created_by ?? 'Unknown'],
                ],
            },
            {
                title: 'Schema Summary',
                rows: [
                    ['Total Columns', formatNumber(m.column_count)],
                    ['Total Rows', formatNumber(m.row_count)],
                    ['Row Groups', formatNumber(m.row_group_count)],
                ],
            },
            {
                title: 'Compression',
                rows: [
                    ['Compressed Size', formatBytes(m.compression_stats.total_compressed)],
                    ['Uncompressed Size', formatBytes(m.compression_stats.total_uncompressed)],
                    ['Compression Ratio', `${(m.compression_stats.ratio * 100).toFixed(1)}%`],
                    ['Space Saved', `${m.compression_stats.space_saved_percent.toFixed(1)}%`],
                ],
            },
        ];
        sections.push(...pageSummary(dump));
        return sections;
    },

    magic_header: node => [layout(node), { title: 'Magic', rows: [['Bytes', node.text]] }],
    magic_footer: node => [layout(node), { title: 'Magic', rows: [['Bytes', node.text]] }],

    footer: node => [
        layout(node),
        {
            title: 'Footer',
            rows: [['Purpose', 'Length of the thrift file metadata, in bytes']],
        },
    ],

    data_region: (node, dump) => [
        layout(node),
        {
            title: 'Data Region',
            rows: [
                ['Row Groups', formatNumber(dump.metadata.row_group_count)],
                ['Column Chunks', formatNumber(columnChunkCount(dump))],
            ],
        },
    ],

    metadata_region: node => {
        const m = node.meta;
        return [
            layout(node),
            {
                title: 'File Metadata',
                rows: [
                    ['Version', m.version],
                    ['Created By', m.created_by ?? 'Unknown'],
                    ['Columns', m.column_count],
                    ['Rows', formatNumber(m.row_count)],
                    ['Row Groups', m.row_group_count],
                ],
            },
        ];
    },

    row_group: node => {
        const rows: Row[] = [['Row Group Index', node.index]];
        if (node.group) {
            const cs = node.group.compression_stats;
            rows.push(
                ['Row Count', formatNumber(node.group.row_count)],
                ['Column Count', Object.keys(node.group.column_chunks).length],
                ['Compressed Size', formatBytes(cs.total_compressed)],
                ['Uncompressed Size', formatBytes(cs.total_uncompressed)],
                ['Compression Ratio', ratio(cs.total_compressed, cs.total_uncompressed)]
            );
            const sc = node.group.sorting_columns;
            if (sc?.length) {
                // column_idx indexes the row group's columns in schema order.
                const names = Object.keys(node.group.column_chunks);
                rows.push([
                    'Sorted By',
                    sc
                        .map(
                            s =>
                                `${names[s.column_idx] ?? `col ${s.column_idx}`} ` +
                                `${s.descending ? 'DESC' : 'ASC'}${s.nulls_first ? ' (nulls first)' : ''}`
                        )
                        .join(', '),
                ]);
            }
        }
        return [layout(node), { title: 'Row Group', rows }];
    },

    column_chunk: (node, dump) => {
        const { chunk, meta, leaf } = node;
        const path = meta?.path_in_schema ?? leaf?.name;
        const geo = path ? geoparquetColumns(dump)[path] : undefined;
        const sections: Section[] = [
            layout(node),
            {
                title: 'Data Types',
                rows: [
                    ['Physical Type', meta?.type ?? leaf?.type ?? 'Unknown'],
                    ['Logical Type', (leaf && logicalTypeLabel(leaf.logical_type)) ?? 'None'],
                    ['Converted Type', leaf?.converted_type ?? 'None'],
                    ['Display Type', columnDisplayType(leaf, geo, meta?.type ?? 'Unknown')],
                ],
            },
            {
                title: 'Compression & Encoding',
                rows: [
                    ['Codec', chunk?.codec ?? meta?.codec ?? 'Unknown'],
                    ...(meta
                        ? ([
                              ['Compressed Size', formatBytes(meta.total_compressed_size)],
                              ['Uncompressed Size', formatBytes(meta.total_uncompressed_size)],
                              [
                                  'Compression Ratio',
                                  ratio(meta.total_compressed_size, meta.total_uncompressed_size),
                              ],
                              ['Encodings', meta.encodings.join(', ')],
                          ] as Row[])
                        : []),
                ],
            },
        ];
        const values = chunk?.num_values ?? meta?.num_values;
        const pageRows: Row[] = isSet(values) ? [['Values', formatNumber(values)]] : [];
        if (meta) {
            pageRows.push(['Data Page Offset', formatOffset(meta.data_page_offset)]);
            if (isSet(meta.dictionary_page_offset)) {
                pageRows.push([
                    'Dictionary Page Offset',
                    formatOffset(meta.dictionary_page_offset),
                ]);
            }
            if (isSet(meta.index_page_offset)) {
                pageRows.push(['Index Page Offset', formatOffset(meta.index_page_offset)]);
            }
            if (isSet(meta.bloom_filter_offset)) {
                pageRows.push([
                    'Bloom Filter',
                    `present @ ${formatOffset(meta.bloom_filter_offset)}`,
                ]);
            }
        }
        // chunk === null => metadata-only export: page structure isn't in the dump.
        if (chunk) {
            const pageCount =
                (chunk.dictionary_page ? 1 : 0) +
                chunk.data_pages.length +
                chunk.index_pages.length;
            pageRows.push(['Total Pages', formatNumber(pageCount)]);
            sections.push({ title: 'Page Layout', rows: pageRows });
        } else {
            sections.push({ title: 'Page Layout', rows: pageRows });
            sections.push({
                title: 'Pages',
                rows: [['Detail', METADATA_ONLY_NOTE]],
                degraded: 'metadata-only',
            });
        }
        if (meta) {
            sections.push(...columnMetaSections(meta, leaf, geo));
        }
        return sections;
    },

    dictionary_page: node => {
        const p = node.page;
        const rows: Row[] = [
            ['Page Type', p.page_type ?? 'DICTIONARY_PAGE'],
            ['Encoding', p.encoding],
            // num_values on a dictionary page is the count of distinct entries
            // (the column chunk's dictionary cardinality), not a row count.
            ['Dictionary Entries', formatNumber(p.num_values)],
            ['Header Size', formatBytes(p.header_size)],
            ['Compressed Size', formatBytes(p.compressed_page_size)],
            ['Uncompressed Size', formatBytes(p.uncompressed_page_size)],
            ['Compression Ratio', ratio(p.compressed_page_size, p.uncompressed_page_size)],
        ];
        if (isSet(p.is_sorted)) {
            rows.push(['Sorted', p.is_sorted ? 'Yes' : 'No']);
        }
        return [layout(node), { title: 'Dictionary Page', rows }];
    },

    data_page: (node, dump) => {
        const p = node.page;
        const rows: Row[] = [
            ['Page Type', p.page_type ?? 'DATA_PAGE'],
            ['Encoding', p.encoding],
            ['Values', formatNumber(p.num_values)],
            ['Header Size', formatBytes(p.header_size)],
            ['Compressed Size', formatBytes(p.compressed_page_size)],
            ['Uncompressed Size', formatBytes(p.uncompressed_page_size)],
            ['Compression Ratio', ratio(p.compressed_page_size, p.uncompressed_page_size)],
        ];
        // V2 pages carry row/null counts and the level bytes inline (unlike V1).
        if ('num_rows' in p) {
            rows.push(
                ['Rows', formatNumber(p.num_rows)],
                ['Nulls', formatNumber(p.num_nulls)],
                ['Definition Levels Size', formatBytes(p.definition_levels_byte_length)],
                ['Repetition Levels Size', formatBytes(p.repetition_levels_byte_length)]
            );
        }
        const sections: Section[] = [layout(node), { title: 'Data Page', rows }];
        if (p.statistics) {
            const leaf = findSchemaLeaf(dump.metadata.schema_root, node.path);
            const wkb = isWkbColumn(leaf, geoparquetColumns(dump)[node.path]);
            sections.push({ title: 'Page Statistics', rows: statRows(p.statistics, leaf, wkb) });
        }
        return sections;
    },

    index_page: node => [
        layout(node),
        {
            title: 'Index Page',
            rows: [
                ['Page Type', node.page.page_type ?? 'INDEX_PAGE'],
                ['Header Size', formatBytes(node.page.header_size)],
                ['Compressed Size', formatBytes(node.page.compressed_page_size)],
                ['Uncompressed Size', formatBytes(node.page.uncompressed_page_size)],
            ],
        },
    ],

    index_region: node => [
        layout(node),
        {
            title: 'Index Region',
            rows: [
                ['Groups', node.children.length],
                [
                    'Purpose',
                    "The file's page indexes (column/offset) and bloom filters, " +
                        'stored between the data and the footer',
                ],
            ],
        },
    ],

    index_group: node => [
        layout(node),
        {
            title: node.label,
            rows: [
                ['Blocks', node.children.length],
                ['Byte Range', `${formatOffset(node.start)}–${formatOffset(node.end)}`],
                [
                    'Purpose',
                    node.id === 'index_bloom_filter'
                        ? 'Per-column bloom filter bitsets for equality skipping'
                        : 'Per-column page-index blocks for predicate push-down and seeking',
                ],
            ],
        },
    ],

    column_index: node => {
        const rows: Row[] = [['Column', node.path]];
        // index === null in a metadata-only export: span only, no contents.
        if (node.index) {
            rows.push(
                ['Boundary Order', node.index.boundary_order],
                ['Pages', formatNumber(node.index.null_pages.length)]
            );
            if (node.index.null_counts?.length) {
                rows.push([
                    'Total Nulls',
                    formatNumber(node.index.null_counts.reduce((a, b) => a + b, 0)),
                ]);
            }
            if (
                node.index.definition_level_histograms?.length ||
                node.index.repetition_level_histograms?.length
            ) {
                rows.push(['Level Histograms', 'present']);
            }
        } else {
            rows.push(['Detail', METADATA_ONLY_NOTE]);
        }
        rows.push(['Purpose', 'Per-page min/max and null stats for predicate push-down']);
        return [
            layout(node),
            { title: 'Column Index', degraded: node.index ? undefined : 'metadata-only', rows },
        ];
    },

    offset_index: node => {
        const rows: Row[] = [['Column', node.path]];
        if (node.index) {
            rows.push(['Page Locations', formatNumber(node.index.page_locations.length)]);
            if (node.index.unencoded_byte_array_data_bytes?.length) {
                rows.push([
                    'Unencoded Size',
                    formatBytes(
                        node.index.unencoded_byte_array_data_bytes.reduce((a, b) => a + b, 0)
                    ),
                ]);
            }
        } else {
            rows.push(['Detail', METADATA_ONLY_NOTE]);
        }
        rows.push(['Purpose', 'Page byte offsets and row ranges for seeking']);
        return [
            layout(node),
            { title: 'Offset Index', degraded: node.index ? undefined : 'metadata-only', rows },
        ];
    },

    bloom_filter: node => [
        layout(node),
        {
            title: 'Bloom Filter',
            rows: [
                ['Column', node.path],
                ['Row Group', node.rowGroup],
                ['Purpose', 'Probabilistic membership test to skip row groups on equality lookups'],
            ],
        },
    ],

    schema_root: node => [
        layout(node),
        {
            title: 'Schema Root',
            rows: [
                ['Name', node.node.name],
                ['Children', node.node.num_children],
                ['Total Columns', formatNumber(countColumns(node.node))],
            ],
        },
    ],

    schema_group: node => {
        const g = node.node;
        const rows: Row[] = [
            ['Name', g.name],
            ['Repetition', g.repetition],
            ['Children', g.num_children],
        ];
        if (isSet(g.field_id)) {
            rows.push(['Field ID', g.field_id]);
        }
        if (g.converted_type) {
            rows.push(['Converted Type', g.converted_type]);
        }
        const logical = logicalTypeLabel(g.logical_type);
        if (logical) {
            rows.push(['Logical Type', logical]);
        }
        return [layout(node), { title: 'Schema Group', rows }];
    },

    schema_leaf: (node, dump) => {
        const l = node.node;
        const geo = geoparquetColumns(dump)[l.name];
        const rows: Row[] = [
            ['Name', l.name],
            ['Physical Type', l.type],
            ['Repetition', l.repetition],
            ['Logical Type', logicalTypeLabel(l.logical_type) ?? 'None'],
            ['Converted Type', l.converted_type ?? 'None'],
            ['Display Type', columnDisplayType(l, geo, l.type)],
        ];
        if (isSet(l.field_id)) {
            rows.push(['Field ID', l.field_id]);
        }
        if (isSet(l.type_length)) {
            rows.push(['Type Length', l.type_length]);
        }
        if (isSet(l.precision)) {
            rows.push(['Precision', l.precision]);
        }
        if (isSet(l.scale)) {
            rows.push(['Scale', l.scale]);
        }
        if (isSet(l.list_semantics)) {
            rows.push(['List Semantics', l.list_semantics]);
        }
        return [layout(node), { title: 'Schema Column', rows }];
    },

    row_groups_meta: node => {
        const totalRows = node.groups.reduce((s, g) => s + g.row_count, 0);
        const compressed = node.groups.reduce(
            (s, g) => s + g.compression_stats.total_compressed,
            0
        );
        const uncompressed = node.groups.reduce(
            (s, g) => s + g.compression_stats.total_uncompressed,
            0
        );
        return [
            layout(node),
            {
                title: 'Row Group Metadata',
                rows: [
                    ['Row Groups', node.groups.length],
                    ['Total Rows', formatNumber(totalRows)],
                    ['Total Compressed', formatBytes(compressed)],
                    ['Total Uncompressed', formatBytes(uncompressed)],
                    ['Compression Ratio', ratio(compressed, uncompressed)],
                ],
            },
        ];
    },

    row_group_meta: node => {
        const cs = node.group.compression_stats;
        return [
            layout(node),
            {
                title: `Row Group ${node.index}`,
                rows: [
                    ['Row Count', formatNumber(node.group.row_count)],
                    ['Column Count', Object.keys(node.group.column_chunks).length],
                    ['Compressed Size', formatBytes(cs.total_compressed)],
                    ['Uncompressed Size', formatBytes(cs.total_uncompressed)],
                ],
            },
        ];
    },

    chunk_meta: (node, dump) => {
        const m = node.meta;
        const leaf = findSchemaLeaf(dump.metadata.schema_root, node.path);
        const geo = geoparquetColumns(dump)[node.path];
        const sections: Section[] = [
            layout(node),
            {
                title: 'Column Metadata',
                rows: [
                    ['Column', node.path],
                    ['Physical Type', m.type],
                    ['Display Type', columnDisplayType(leaf, geo, m.type)],
                    ['Codec', m.codec],
                    ['Encodings', m.encodings.join(', ')],
                    ['Values', formatNumber(m.num_values)],
                    ['Compressed Size', formatBytes(m.total_compressed_size)],
                    ['Uncompressed Size', formatBytes(m.total_uncompressed_size)],
                    ['Data Page Offset', formatOffset(m.data_page_offset)],
                ],
            },
            ...columnMetaSections(m, leaf, geo),
        ];
        return sections;
    },

    kv_meta: node => [
        layout(node),
        {
            title: 'Key-Value Metadata',
            rows: node.entries.map((e): Row => {
                const [shown, copy] = truncateCopy(e.value, 50);
                return copy === undefined ? [e.key, shown] : [e.key, shown, copy];
            }),
        },
    ],

    kv_entry: node => [
        layout(node),
        { title: 'Key-Value Metadata', rows: [['Key', node.entry.key]] },
        valueViewer(node.entry.value),
    ],
};

/** Kinds that have a panel handler (exhaustiveness checks). */
export const PANEL_KINDS = new Set<Kind>(Object.keys(PANELS) as Kind[]);

export class InfoPanelManager {
    private container: HTMLElement;
    private infoPanel: HTMLElement;
    /** Live bloom-filter probe; null for JSON-dump / metadata-only loads. */
    private bloomProbe: BloomProbe | null;
    /** Live whole-filter density reader; same lifecycle as bloomProbe. */
    private bloomDensity: BloomDensity | null;
    /** Live single-block byte reader; same lifecycle as bloomProbe. */
    private bloomBlock: BloomBlock | null;
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

    constructor(
        container: HTMLElement,
        bloomProbe: BloomProbe | null = null,
        bloomDensity: BloomDensity | null = null,
        bloomBlock: BloomBlock | null = null,
        valuePreview: ValuePreview | null = null,
        dictionaryPreview: DictionaryPreview | null = null,
        recovery: RecoveryActions = { loadFullStructure: null, downloadFullFile: null }
    ) {
        this.container = container;
        this.container.innerHTML = '';
        this.bloomProbe = bloomProbe;
        this.bloomDensity = bloomDensity;
        this.bloomBlock = bloomBlock;
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
        this.current = { node, dump };
        // ponytail: registry keys are correlated with node.kind by construction;
        // the mapped type can't prove that at the call site, so widen once here.
        const handler = PANELS[node.kind] as (n: SegmentNode, d: AnyDump) => Section[];
        const heading = node.kind === 'file' ? 'File Overview' : describe(node);
        const sections = handler(node, dump);
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
            this.appendRecovery(
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
     * Interactive bloom-filter section (full-width): the whole filter renders as
     * a clickable density strip (one cell per 256-bit block for small filters,
     * else per contiguous bucket) plus one selected block's 8×32 bit-grid
     * (default block 0). Clicking a strip cell fetches and views that block —
     * works identically at any filter size (the block's 32 bytes come on demand
     * via bloomBlock, cached so nothing refetches). Probing a value selects the
     * block it lands in (no fetch — the probe result carries its bytes), marks
     * the strip cell, and shows the eight checked bits hit/miss with the verdict
     * + lineage. Clear removes the probe overlay but keeps the selected block.
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
            `<div class="bloom-strip-wrap"></div>` +
            `<div class="bloom-block-wrap"></div>` +
            `<div class="bloom-probe-result"></div>`;
        const input = section.querySelector<HTMLInputElement>('.bloom-probe-value')!;
        const probeBtn = section.querySelector<HTMLButtonElement>('.bloom-probe-btn')!;
        const clearBtn = section.querySelector<HTMLButtonElement>('.bloom-probe-clear')!;
        const stripWrap = section.querySelector<HTMLElement>('.bloom-strip-wrap')!;
        const blockWrap = section.querySelector<HTMLElement>('.bloom-block-wrap')!;
        const result = section.querySelector<HTMLElement>('.bloom-probe-result')!;

        // Closure state: the fetched density (kept so the strip re-draws without
        // re-reading the filter), the block currently being viewed (default 0),
        // the last probe (null until probed), a cache of fetched block bytes
        // (avoid refetching), and a monotonic token so a slow fetch that resolves
        // after the user clicks another cell is ignored (only the latest wins).
        let density: BloomDensityResult | null = null;
        let selectedBlock = 0;
        let probe: BloomProbeResult | null = null;
        const blockCache = new Map<number, Uint8Array>();
        let renderToken = 0;

        // The selected block's 32 bytes, or null when not yet available: the
        // probed block reads straight from the probe result; any other block
        // comes from the cache (missing => the async render fetches it).
        const bytesFor = (block: number): Uint8Array | null => {
            if (probe && block === probe.blockIndex) {
                return base64Bytes(probe.block) ?? null;
            }
            return blockCache.get(block) ?? null;
        };

        // Draw the block grid for `bytes` (or a placeholder), plus the verdict and
        // lineage when it's the probed block being viewed.
        const drawBlock = (bytes: Uint8Array | null, viewingProbed: boolean): void => {
            blockWrap.innerHTML =
                bytes && bytes.length >= 32
                    ? (viewingProbed ? renderBloomLineage(probe!) : '') +
                      renderBloomBlock(bytes, viewingProbed ? probe!.bits : undefined)
                    : '<div class="bloom-lineage">Click a strip cell or probe a value.</div>';
            if (viewingProbed) {
                const verdict = probe!.mightContain
                    ? '<strong>maybe present</strong> — a bloom filter can only ever ' +
                      'answer “definitely not” or “maybe”; this could be a false positive.'
                    : '<strong>definitely not present</strong> — the filter has no false ' +
                      'negatives, so a reader can safely skip this row group.';
                result.innerHTML =
                    `<div class="bloom-verdict bloom-verdict-${probe!.mightContain ? 'maybe' : 'no'}">` +
                    `${verdict}</div>`;
            } else {
                result.innerHTML = '';
            }
        };

        const render = (): void => {
            if (!density) {
                return;
            }
            // Strip: mark the selected cell always, the probed cell while probed.
            stripWrap.innerHTML = renderBloomStrip(density, selectedBlock, probe?.blockIndex);
            const viewingProbed = probe !== null && selectedBlock === probe.blockIndex;
            const bytes = bytesFor(selectedBlock);
            if (bytes || !this.bloomBlock) {
                drawBlock(bytes, viewingProbed);
                return;
            }
            // Miss: fetch this block on demand. Bump the token so a click on a
            // different cell mid-fetch discards this stale result. A brief loading
            // note occupies the grid while the 32 bytes come back.
            const token = ++renderToken;
            const block = selectedBlock;
            blockWrap.innerHTML = '<div class="bloom-lineage">Loading block…</div>';
            result.innerHTML = '';
            this.bloomBlock(node.rowGroup, node.path, block).then(
                b64 => {
                    if (token !== renderToken) {
                        return; // a newer selection superseded this fetch
                    }
                    const decoded = base64Bytes(b64) ?? null;
                    if (decoded) {
                        blockCache.set(block, decoded);
                    }
                    drawBlock(decoded, probe !== null && block === probe.blockIndex);
                },
                (error: unknown) => {
                    if (token !== renderToken) {
                        return;
                    }
                    if (isIncrementalReadError(error) && this.recovery.downloadFullFile) {
                        this.appendRecovery(
                            blockWrap,
                            RANGE_UNSUPPORTED_MESSAGE,
                            'Download full file',
                            this.recovery.downloadFullFile
                        );
                        return;
                    }
                    const message = (error as Error).message.trim();
                    blockWrap.textContent = `Block unavailable: ${message.split('\n').pop()!}`;
                }
            );
        };

        // Base graphic: fetch the whole filter's density once and draw block 0.
        if (this.bloomDensity) {
            stripWrap.textContent = 'Loading filter…';
            this.bloomDensity(node.rowGroup, node.path).then(
                d => {
                    density = d;
                    render();
                },
                (error: unknown) => {
                    if (isIncrementalReadError(error) && this.recovery.downloadFullFile) {
                        this.appendRecovery(
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

        // Delegated strip-cell selection: click a cell to view its block. Works
        // at any filter size — the block's bytes are fetched on demand by render.
        stripWrap.addEventListener('click', e => {
            const cell = (e.target as HTMLElement).closest('.bloom-strip-cell');
            if (!(cell instanceof SVGElement) || !density) {
                return;
            }
            selectedBlock = Number(cell.getAttribute('data-block'));
            render();
        });

        const run = (): void => {
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
                result.textContent = leaf
                    ? `'${input.value}' is not a valid ${leaf.type} value${
                          binary ? ' (expected base64)' : ''
                      }`
                    : `column '${node.path}' was not found in the schema`;
                return;
            }
            result.textContent = 'Probing...';
            this.bloomProbe!(node.rowGroup, node.path, value).then(
                res => {
                    probe = res;
                    selectedBlock = res.blockIndex;
                    clearBtn.disabled = false;
                    // Invalidate any in-flight block fetch: the probed block draws
                    // synchronously from the probe result, so a stale fetch must
                    // not overwrite it when it resolves.
                    renderToken++;
                    render();
                },
                (error: unknown) => {
                    if (isIncrementalReadError(error) && this.recovery.downloadFullFile) {
                        this.appendRecovery(
                            result,
                            RANGE_UNSUPPORTED_MESSAGE,
                            'Download full file',
                            this.recovery.downloadFullFile
                        );
                        return;
                    }
                    // Pyodide errors embed the python traceback; the last line
                    // is the actual exception.
                    const message = (error as Error).message.trim();
                    result.textContent = `Probe failed: ${message.split('\n').pop()!}`;
                }
            );
        };
        probeBtn.addEventListener('click', run);
        clearBtn.addEventListener('click', () => {
            // Drop the probe overlay but keep the currently selected block shown.
            // The block may need a fresh fetch now (it was the probe's block, whose
            // bytes came from the probe result); render handles that. Bump the
            // token so any in-flight fetch from before is discarded.
            probe = null;
            clearBtn.disabled = true;
            renderToken++;
            render();
        });
        input.addEventListener('keypress', e => {
            if ((e as KeyboardEvent).key === 'Enter') {
                run();
            }
        });
        return section;
    }

    hide(): void {
        this.infoPanel.style.display = 'none';
    }

    /** Render `message` in `el`, plus a wired recovery button when `action` exists. */
    private appendRecovery(
        el: HTMLElement,
        message: string,
        label: string,
        action: (() => void) | null
    ): void {
        el.textContent = message;
        if (action) {
            el.append(' ');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn recovery-btn';
            btn.textContent = label;
            btn.addEventListener('click', action);
            el.appendChild(btn);
        }
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
