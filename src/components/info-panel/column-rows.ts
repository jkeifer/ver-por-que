/**
 * Row/Section builders for a column's metadata: the physical-layout row, stats
 * (min/max with logical formatting + copy payloads), geospatial extents, size &
 * encoding stats, the per-page column/offset index tables, and the page-summary
 * overview. Plus the JSON value viewer used for key-value entries. All pure —
 * they return `Section`/`Row`/HTML strings the registry assembles.
 */
import { formatBytes, formatNumber, formatOffset } from '../../format';
import {
    base64Bytes,
    decodeStatValue,
    formatStatValue,
    isBinaryLeaf,
} from '../../business/stat-values';
import { describeWkb } from '../../business/wkb';
import { isWkbColumn, type GeoColumn } from '../../domain/geoparquet';
import { isSet, type SegmentNode } from '../../business/segment-tree';
import type {
    AnyDump,
    ColumnIndex,
    ColumnMetadata,
    ColumnStatistics,
    OffsetIndex,
    SchemaGroup,
    SchemaLeaf,
    SchemaRoot,
} from '../../types';
import { escapeHtml, truncateCopy, type Row, type Section } from './view';

export const METADATA_ONLY_NOTE =
    'Page detail is not in a metadata-only dump — load the original .parquet to see pages.';

/** Standard Start/End/Size section every physical segment shows. */
export function layout(node: SegmentNode): Section {
    return {
        title: 'Physical Layout',
        rows: [
            ['Start Offset', formatOffset(node.start)],
            ['End Offset', formatOffset(node.end)],
            ['Size', formatBytes(node.end - node.start)],
        ],
    };
}

export function ratio(compressed: number, uncompressed: number): string {
    return uncompressed > 0 ? `${((compressed / uncompressed) * 100).toFixed(1)}%` : 'N/A';
}

export function countColumns(node: SchemaRoot | SchemaGroup | SchemaLeaf): number {
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

export function statRows(stats: ColumnStatistics, leaf?: SchemaLeaf | null, wkb = false): Row[] {
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
 * A column index's real payload: per-page min/max and null counts, decoded to
 * the column's logical type — the stats a reader scans to skip whole pages that
 * can't match a predicate. All-null pages have no meaningful min/max (dash); a
 * value is clipped for the cell (the point is the range, not the full string).
 */
export function columnIndexTable(index: ColumnIndex, leaf: SchemaLeaf | null | undefined): string {
    const clip = (s: string): string => (s.length > 28 ? `${s.slice(0, 27)}…` : s);
    const stat = (v: string | undefined, nullPage: boolean): string => {
        if (nullPage || v === undefined) {
            return '<span class="value-preview-null">—</span>';
        }
        return escapeHtml(clip((leaf ? formatStatValue(v, leaf) : undefined) ?? v));
    };
    const body = index.null_pages
        .map((nullPage, i) => {
            const nulls = index.null_counts?.[i];
            return (
                `<tr><td class="idx-num">${i}</td>` +
                `<td>${stat(index.min_values[i], nullPage)}</td>` +
                `<td>${stat(index.max_values[i], nullPage)}</td>` +
                `<td class="idx-num">${nulls === undefined ? '—' : formatNumber(nulls)}</td></tr>`
            );
        })
        .join('');
    return (
        `<div class="value-preview-table-wrap"><table class="index-table">` +
        `<thead><tr><th>Page</th><th>Min</th><th>Max</th><th>Nulls</th></tr></thead>` +
        `<tbody>${body}</tbody></table></div>`
    );
}

/**
 * An offset index's real payload: for each page, the row it starts at, its byte
 * offset in the file, and its compressed size — the map a reader uses to seek
 * straight to the page holding a wanted row range without touching the rest.
 */
export function offsetIndexTable(index: OffsetIndex): string {
    const body = index.page_locations
        .map(
            (p, i) =>
                `<tr><td class="idx-num">${i}</td>` +
                `<td class="idx-num">${formatNumber(p.first_row_index)}</td>` +
                `<td class="idx-num">${formatOffset(p.offset)}</td>` +
                `<td class="idx-num">${formatBytes(p.compressed_page_size)}</td></tr>`
        )
        .join('');
    return (
        `<div class="value-preview-table-wrap"><table class="index-table">` +
        `<thead><tr><th>Page</th><th>First row</th><th>Offset</th><th>Size</th></tr></thead>` +
        `<tbody>${body}</tbody></table></div>`
    );
}

/**
 * Statistics + geospatial + size/encoding sections for a column's metadata.
 * Shared by the physical `column_chunk` view and the metadata-only `chunk_meta`
 * view so both decode WKB min/max and surface the same extents consistently.
 */
export function columnMetaSections(
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
export function pageSummary(dump: AnyDump): Section[] {
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

export function valueViewer(value: string): Section {
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
