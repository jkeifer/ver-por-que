/**
 * Info Panel Manager
 *
 * One declarative registry maps each segment `kind` to the sections it shows.
 * A single renderer turns sections into HTML. No per-kind generate* methods, no
 * shape-sniffing dispatch — the node's kind already says what it is.
 */
import { formatBytes, formatNumber, formatOffset } from '../format';
import { logicalTypeLabel, displayType } from '../domain/parquet-type-resolver';
import { OP_LABEL } from '../business/pruning';
import type { Resolution } from '../business/query-model';
import {
    describe,
    findSchemaLeaf,
    isSet,
    type Kind,
    type SegmentNode,
} from '../business/segment-tree';
import { base64Bytes, formatStatValue, parsePredicateValue } from '../business/stat-values';
import { describeWkb } from '../business/wkb';
import type { PreviewEntry, PreviewResult, PreviewValue } from '../js/worker/pyodide-parquet';
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

/** One column's entry in the GeoParquet `geo` metadata. */
interface GeoColumn {
    encoding?: string;
    /** [xmin, ymin, xmax, ymax] or [xmin, ymin, zmin, xmax, ymax, zmax]. */
    bbox?: number[];
    geometry_types?: string[];
}

/**
 * GeoParquet (used by Overture and most geo tooling) predates the native
 * Parquet GEOMETRY logical type: the geometry column is a plain BYTE_ARRAY and
 * its WKB encoding + spatial extent are declared in the file's `geo`
 * key-value metadata instead. Returns the per-column `geo` entries, keyed by
 * column name (empty when the file isn't GeoParquet).
 */
function geoparquetColumns(dump: AnyDump): Record<string, GeoColumn> {
    const entry = dump.metadata.key_value_metadata?.find(e => e.key === 'geo');
    if (!entry?.value) {
        return {};
    }
    try {
        return (JSON.parse(entry.value) as { columns?: Record<string, GeoColumn> }).columns ?? {};
    } catch {
        return {};
    }
}

/** WKB geometry column: a native GEOMETRY/GEOGRAPHY leaf, or a GeoParquet column. */
function isWkbColumn(leaf: SchemaLeaf | null | undefined, geo: GeoColumn | undefined): boolean {
    const lt = leaf?.logical_type?.logical_type;
    return lt === 'GEOMETRY' || lt === 'GEOGRAPHY' || geo?.encoding === 'WKB';
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
export type BloomProbe = (rowGroup: number, column: string, value: string) => Promise<boolean>;

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
 * Rewrite a GEOMETRY/GEOGRAPHY cell (raw WKB shipped as base64) into a readable
 * summary. Falls back to the original base64 on nulls, non-strings, or bytes
 * that don't parse as WKB — so a non-geometry value is never mangled.
 */
function wkbCell(value: PreviewValue): PreviewValue {
    if (typeof value !== 'string') {
        return value;
    }
    const bytes = base64Bytes(value);
    return (bytes && describeWkb(bytes)) ?? value;
}

/** A single value cell: NULL is explicit; long values ellipsize. */
function previewValueCell(value: PreviewValue): string {
    if (value === null) {
        return '<span class="value-preview-null">NULL</span>';
    }
    const s = String(value);
    return escapeHtml(
        s.length > PREVIEW_VALUE_MAX_CHARS ? `${s.slice(0, PREVIEW_VALUE_MAX_CHARS - 1)}…` : s
    );
}

/** tbody rows; `#` is each value's own absolute page index (sparse under null-skip). */
function renderPreviewRows(entries: PreviewEntry[]): string {
    return entries
        .map(
            entry =>
                `<tr><td class="value-preview-index">${entry.index}</td>` +
                `<td class="value-preview-value">${previewValueCell(entry.value)}</td>` +
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
    onToggleNulls: (hide: boolean) => void;
    onPrev: () => void;
    onNext: () => void;
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
    const range =
        total === 0
            ? '0 values'
            : `${formatNumber(start + 1)}–${formatNumber(next)} of ${formatNumber(total)} ` +
              `value${total === 1 ? '' : 's'}`;
    const info = nulls > 0 ? `${range} · ${formatNumber(nulls)} null` : range;
    const toggle =
        nulls > 0
            ? `<label class="value-preview-filter">` +
              `<input type="checkbox" class="value-preview-hide-nulls"${hideNulls ? ' checked' : ''}> ` +
              `hide nulls</label>`
            : '';
    const canNext = next < total;
    const buttons =
        view.canPrev || canNext
            ? `<div class="value-preview-buttons">` +
              `<button type="button" class="btn btn-sm value-preview-prev"` +
              `${view.canPrev ? '' : ' disabled'}>‹ Prev</button>` +
              `<button type="button" class="btn btn-sm value-preview-next"` +
              `${canNext ? '' : ' disabled'}>Next ›</button></div>`
            : '';
    result.innerHTML =
        `<div class="value-preview-table-wrap"><table class="value-preview-table">` +
        `<thead><tr><th>#</th><th>Value</th><th title="definition level">def</th>` +
        `<th title="repetition level">rep</th></tr></thead>` +
        `<tbody>${renderPreviewRows(entries)}</tbody></table></div>` +
        `<div class="value-preview-pager">` +
        `<div class="value-preview-info"><span class="value-preview-range">${info}</span>${toggle}</div>` +
        `${buttons}</div>`;
    result
        .querySelector<HTMLInputElement>('.value-preview-hide-nulls')
        ?.addEventListener('change', e =>
            view.onToggleNulls((e.target as HTMLInputElement).checked)
        );
    result.querySelector('.value-preview-prev')?.addEventListener('click', () => view.onPrev());
    result.querySelector('.value-preview-next')?.addEventListener('click', () => view.onNext());
}

type Row = [string, string | number];
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

/** Bounding box + geometry-type inventory for GEOMETRY/GEOGRAPHY columns. */
function geospatialRows(gs: NonNullable<ColumnMetadata['geospatial_statistics']>): Row[] {
    const rows: Row[] = [];
    const b = gs.bbox;
    if (b) {
        rows.push(['X Range', `${b.xmin} … ${b.xmax}`], ['Y Range', `${b.ymin} … ${b.ymax}`]);
        if (isSet(b.zmin) && isSet(b.zmax)) {
            rows.push(['Z Range', `${b.zmin} … ${b.zmax}`]);
        }
        if (isSet(b.mmin) && isSet(b.mmax)) {
            rows.push(['M Range', `${b.mmin} … ${b.mmax}`]);
        }
    }
    if (gs.geospatial_types?.length) {
        rows.push(['Geometry Types', gs.geospatial_types.join(', ')]);
    }
    return rows;
}

/** Bounding-box + geometry-type rows from a GeoParquet column entry. */
function geoparquetRows(g: GeoColumn): Row[] {
    const rows: Row[] = [];
    const b = g.bbox;
    if (b && (b.length === 4 || b.length === 6)) {
        const xmax = b.length === 6 ? b[3] : b[2];
        const ymax = b.length === 6 ? b[4] : b[3];
        rows.push(['X Range', `${b[0]} … ${xmax}`], ['Y Range', `${b[1]} … ${ymax}`]);
        if (b.length === 6) {
            rows.push(['Z Range', `${b[2]} … ${b[5]}`]);
        }
    }
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
    const val = (v: string | null | undefined): string => {
        if (v === null || v === undefined) {
            return 'N/A';
        }
        if (wkb) {
            // WKB min/max are geometries too; summarize like the value preview.
            const bytes = base64Bytes(v);
            const summary = bytes && describeWkb(bytes);
            if (summary) {
                return summary;
            }
        }
        const display = leaf ? formatStatValue(v, leaf) : undefined;
        const s = display ?? v;
        return s.length > 50 ? `${s.slice(0, 47)}...` : s;
    };
    const rows: Row[] = [
        ['Min Value', val(stats.min_value)],
        ['Max Value', val(stats.max_value)],
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
    if (meta.geospatial_statistics) {
        const rows = geospatialRows(meta.geospatial_statistics);
        if (rows.length) {
            sections.push({ title: 'Geospatial Statistics', rows });
        }
    }
    // GeoParquet spatial extent lives in the file's `geo` metadata, not on the
    // chunk (Overture writes no native geospatial_statistics).
    if (geo) {
        const rows = geoparquetRows(geo);
        if (rows.length) {
            sections.push({ title: 'Geospatial Statistics', rows });
        }
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
    // Trusted html: each key/count is escaped, so a crafted encoding/page-type
    // name can't inject markup. Rendered as its own card, one item per row.
    const breakdown = (m: Record<string, number>): string =>
        `<div class="info-grid">${Object.entries(m)
            .map(
                ([k, n]) =>
                    `<div class="info-item"><span class="info-label">${escapeHtml(k)}:</span>` +
                    `<span class="info-value">${formatNumber(n)} (${pct(n)}%)</span></div>`
            )
            .join('')}</div>`;
    if (Object.keys(pageTypes).length > 0) {
        sections.push({ title: 'Page Types', html: breakdown(pageTypes) });
    }
    if (Object.keys(encodings).length > 0) {
        sections.push({ title: 'Encodings', html: breakdown(encodings) });
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
                    // GeoParquet geometry has no native logical type, so the pure
                    // leaf displayType falls back to BYTE_ARRAY; name it from the
                    // `geo` metadata instead so it doesn't read as an opaque blob.
                    [
                        'Display Type',
                        geo?.encoding === 'WKB'
                            ? 'WKB geometry (GeoParquet)'
                            : leaf
                              ? displayType(leaf)
                              : (meta?.type ?? 'Unknown'),
                    ],
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

    dictionary_page: node => [
        layout(node),
        {
            title: 'Dictionary Page',
            rows: [
                ['Page Type', node.page.page_type ?? 'DICTIONARY_PAGE'],
                ['Encoding', node.page.encoding],
                ['Values', formatNumber(node.page.num_values)],
                ['Header Size', formatBytes(node.page.header_size)],
                ['Compressed Size', formatBytes(node.page.compressed_page_size)],
                ['Uncompressed Size', formatBytes(node.page.uncompressed_page_size)],
                [
                    'Compression Ratio',
                    ratio(node.page.compressed_page_size, node.page.uncompressed_page_size),
                ],
                ...(isSet(node.page.is_sorted)
                    ? ([['Sorted', node.page.is_sorted ? 'Yes' : 'No']] as Row[])
                    : []),
            ],
        },
    ],

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

    column_index: node => [
        layout(node),
        {
            title: 'Column Index',
            degraded: node.index ? undefined : 'metadata-only',
            rows: [
                ['Column', node.path],
                // index === null in a metadata-only export: span only, no contents.
                ...(node.index
                    ? ([
                          ['Boundary Order', node.index.boundary_order],
                          ['Pages', formatNumber(node.index.null_pages.length)],
                          ...(node.index.null_counts?.length
                              ? [
                                    [
                                        'Total Nulls',
                                        formatNumber(
                                            node.index.null_counts.reduce((a, b) => a + b, 0)
                                        ),
                                    ],
                                ]
                              : []),
                          ...(node.index.definition_level_histograms?.length ||
                          node.index.repetition_level_histograms?.length
                              ? [['Level Histograms', 'present']]
                              : []),
                      ] as Row[])
                    : ([['Detail', METADATA_ONLY_NOTE]] as Row[])),
                ['Purpose', 'Per-page min/max and null stats for predicate push-down'],
            ],
        },
    ],

    offset_index: node => [
        layout(node),
        {
            title: 'Offset Index',
            degraded: node.index ? undefined : 'metadata-only',
            rows: [
                ['Column', node.path],
                ...(node.index
                    ? ([
                          ['Page Locations', formatNumber(node.index.page_locations.length)],
                          ...(node.index.unencoded_byte_array_data_bytes?.length
                              ? [
                                    [
                                        'Unencoded Size',
                                        formatBytes(
                                            node.index.unencoded_byte_array_data_bytes.reduce(
                                                (a, b) => a + b,
                                                0
                                            )
                                        ),
                                    ],
                                ]
                              : []),
                      ] as Row[])
                    : ([['Detail', METADATA_ONLY_NOTE]] as Row[])),
                ['Purpose', 'Page byte offsets and row ranges for seeking'],
            ],
        },
    ],

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

    schema_leaf: node => {
        const l = node.node;
        const rows: Row[] = [
            ['Name', l.name],
            ['Physical Type', l.type],
            ['Repetition', l.repetition],
            ['Logical Type', logicalTypeLabel(l.logical_type) ?? 'None'],
            ['Converted Type', l.converted_type ?? 'None'],
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
                    // GeoParquet geometry has no logical type; name it so BYTE_ARRAY
                    // doesn't read as an opaque blob (mirrors the column_chunk view).
                    ...(geo?.encoding === 'WKB'
                        ? ([['Interpreted As', 'WKB geometry (GeoParquet)']] as Row[])
                        : []),
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
            rows: node.entries.map(e => [
                e.key,
                e.value.length > 50 ? `${e.value.slice(0, 47)}...` : e.value,
            ]),
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
    /** Live value decoder; null for JSON-dump / metadata-only loads. */
    private valuePreview: ValuePreview | null;
    /** Recovery actions for degraded cards; both null when no fetchable source. */
    private recovery: RecoveryActions;
    /** Active query resolution, or null when no predicate has run. */
    private query: Resolution | null = null;
    /** Last shown node/dump, so a query run can refresh the open panel. */
    private current: { node: SegmentNode; dump: AnyDump } | null = null;

    constructor(
        container: HTMLElement,
        bloomProbe: BloomProbe | null = null,
        valuePreview: ValuePreview | null = null,
        recovery: RecoveryActions = { loadFullStructure: null, downloadFullFile: null }
    ) {
        this.container = container;
        this.container.innerHTML = '';
        this.bloomProbe = bloomProbe;
        this.valuePreview = valuePreview;
        this.recovery = recovery;
        this.infoPanel = document.createElement('div');
        this.infoPanel.className = 'info-panel';
        this.infoPanel.style.display = 'none';
        this.container.appendChild(this.infoPanel);
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
                        entries: isWkb
                            ? res.values.map(e => ({ ...e, value: wkbCell(e.value) }))
                            : res.values,
                        start: offset,
                        next: res.next,
                        total: res.total,
                        nulls: res.nulls,
                        hideNulls,
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
                (error: unknown) => {
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
                    // Pyodide errors embed the python traceback; the last line
                    // is the actual exception. Keep the button so it's retryable.
                    const message = (error as Error).message.trim();
                    button.disabled = false;
                    result.textContent = `Preview failed: ${message.split('\n').pop()!}`;
                }
            );
        };
        button.addEventListener('click', () => {
            button.disabled = true;
            result.textContent = 'Decoding values...';
            load(0);
        });
        return section;
    }

    /** Interactive bloom-filter probe: type a value, ask the worker's filter. */
    private buildBloomProbeSection(
        node: Extract<SegmentNode, { kind: 'bloom_filter' }>,
        dump: AnyDump
    ): HTMLElement {
        const leaf = findSchemaLeaf(dump.metadata.schema_root, node.path);
        const section = document.createElement('div');
        section.className = 'info-section regular-card bloom-probe-section';
        section.innerHTML =
            `<h5 class="info-section-title">Probe a Value</h5>` +
            `<div class="bloom-probe-controls">` +
            `<input type="text" class="bloom-probe-value" placeholder="${
                leaf ? `${leaf.type} value` : 'value'
            }">` +
            `<button type="button" class="bloom-probe-btn">Probe</button>` +
            `</div>` +
            `<div class="bloom-probe-result"></div>`;
        const input = section.querySelector<HTMLInputElement>('.bloom-probe-value')!;
        const result = section.querySelector<HTMLElement>('.bloom-probe-result')!;
        const run = (): void => {
            // Same typed-input parsing as the query panel: reject input that
            // isn't a valid value for the column's physical type.
            const parsed = leaf ? parsePredicateValue(input.value, leaf) : undefined;
            if (parsed === undefined) {
                result.textContent = leaf
                    ? `'${input.value}' is not a valid ${leaf.type} value`
                    : `column '${node.path}' was not found in the schema`;
                return;
            }
            result.textContent = 'Probing...';
            this.bloomProbe!(node.rowGroup, node.path, String(parsed)).then(
                might => {
                    // Static strings only: nothing user-typed goes into innerHTML.
                    result.innerHTML = might
                        ? '<strong>maybe present</strong> — a bloom filter can only ever ' +
                          'answer “definitely not” or “maybe”; this could be a false positive.'
                        : '<strong>definitely not present</strong> — the filter has no false ' +
                          'negatives, so a reader can safely skip this row group.';
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
        section.querySelector('.bloom-probe-btn')!.addEventListener('click', run);
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
                .map(
                    ([label, value]) =>
                        `<div class="info-item"><span class="info-label">${escapeHtml(String(label))}:</span><span class="info-value">${escapeHtml(String(value))}</span></div>`
                )
                .join('')}</div>`;
        const card = section.html ? 'large-card' : 'regular-card';
        const recovery =
            section.degraded === 'metadata-only' && this.recovery.loadFullStructure
                ? `<button type="button" class="btn recovery-btn" data-action="upgrade">Load full structure from source</button>`
                : '';
        return `<div class="info-section ${card}"><h5 class="info-section-title">${section.title}</h5>${body}${recovery}</div>`;
    }
}
