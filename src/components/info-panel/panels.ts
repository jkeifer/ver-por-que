/**
 * The declarative panel registry: one handler per segment `kind` mapping a node
 * to the sections it shows. No shape-sniffing dispatch — the node's kind already
 * says what it is. Handlers are pure (node/dump → Section[]); the interactive
 * bloom/preview cards are appended separately by the manager.
 */
import { formatBytes, formatNumber, formatOffset } from '../../format';
import { logicalTypeLabel } from '../../domain/parquet-type-resolver';
import { columnDisplayType, geoparquetColumns, isWkbColumn } from '../../domain/geoparquet';
import { findSchemaLeaf, isSet, type Kind, type SegmentNode } from '../../business/segment-tree';
import type { AnyDump } from '../../types';
import { truncateCopy, type Row, type Section } from './view';
import {
    columnIndexTable,
    columnMetaSections,
    countColumns,
    layout,
    METADATA_ONLY_NOTE,
    offsetIndexTable,
    pageSummary,
    ratio,
    statRows,
    valueViewer,
} from './column-rows';

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

type Handler<K extends Kind> = (
    node: Extract<SegmentNode, { kind: K }>,
    dump: AnyDump
) => Section[];
type Registry = { [K in Kind]: Handler<K> };

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
                ['Columns', node.children.length],
                [
                    'Purpose',
                    node.id === 'index_bloom_filter'
                        ? 'Per-column bloom filter bitsets for equality skipping'
                        : 'Per-column page-index blocks for predicate push-down and seeking',
                ],
            ],
        },
    ],

    column_index: (node, dump) => {
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
        const sections: Section[] = [
            layout(node),
            { title: 'Column Index', degraded: node.index ? undefined : 'metadata-only', rows },
        ];
        // The actual per-page stats, decoded to the column's type — the reason
        // this segment exists (skip pages that can't match a predicate).
        if (node.index) {
            const leaf = findSchemaLeaf(dump.metadata.schema_root, node.path);
            sections.push({
                title: 'Per-Page Statistics',
                html: columnIndexTable(node.index, leaf),
            });
        }
        return sections;
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
        const sections: Section[] = [
            layout(node),
            { title: 'Offset Index', degraded: node.index ? undefined : 'metadata-only', rows },
        ];
        // Per-page seek map: where each page starts (row + byte offset) and how
        // big it is — how a reader jumps straight to a wanted row range.
        if (node.index) {
            sections.push({ title: 'Page Locations', html: offsetIndexTable(node.index) });
        }
        return sections;
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

    row_group_fields: node => [
        layout(node),
        {
            title: 'Row-Group Fields',
            rows: [
                [
                    'Purpose',
                    'Row-group-level metadata (num_rows, total_byte_size, ' +
                        'sorting_columns, ordinal…) — the RowGroup thrift fields ' +
                        'after the per-column metadata',
                ],
            ],
        },
    ],

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

/** Look up the sections for a node. The registry key is correlated with
 *  node.kind by construction; the mapped type can't prove that at the call
 *  site, so the manager widens once here. */
export function panelSections(node: SegmentNode, dump: AnyDump): Section[] {
    const handler = PANELS[node.kind] as (n: SegmentNode, d: AnyDump) => Section[];
    return handler(node, dump);
}

/** Kinds that have a panel handler (exhaustiveness checks). */
export const PANEL_KINDS = new Set<Kind>(Object.keys(PANELS) as Kind[]);
