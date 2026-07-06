import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateFile, validateMetadata } from '../src/generated/validate.js';
import {
    columnStats,
    evaluate,
    isValidPredicate,
    leafColumns,
    parseQueryState,
    rowCounts,
    type Predicate,
} from '../src/business/pruning';
import { project, findNode } from '../src/business/segment-tree';
import type { Dump, MetadataDump, SchemaLeaf } from '../src/types';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

// String column, one row group, one page; footer stats + column index both
// cover the range ['Hello', 'today'] (base64 raw bytes in the dump).
function loadStats(): Dump {
    const dump: unknown = JSON.parse(
        readFileSync(`${FIXTURES}data_index_bloom_encoding_stats_expected.json`, 'utf8')
    );
    if (!validateFile(dump)) {
        throw new Error('stats fixture failed schema validation');
    }
    return dump;
}

function loadMetadataExport(): MetadataDump {
    const dump: unknown = JSON.parse(readFileSync(`${FIXTURES}metadata-export.json`, 'utf8'));
    if (!validateMetadata(dump)) {
        throw new Error('metadata-export fixture failed schema validation');
    }
    return dump;
}

const p = (op: Predicate['op'], value: string): Predicate => ({ column: 'String', op, value });

describe('evaluate — row groups (footer statistics)', () => {
    const dump = loadStats();

    it('keeps the row group when the query value is inside the range', () => {
        const { rowGroups } = evaluate(dump, [p('eq', 'Hello')]);
        expect(rowGroups.size).toBe(1);
        expect(rowGroups.get(0)).toEqual({
            pruned: false,
            reason: "kept — range ['Hello','today'] overlaps query (predicate on String)",
        });
    });

    it('prunes on > past the max, with the stated reason', () => {
        const d = evaluate(dump, [p('gt', 'zzz')]).rowGroups.get(0)!;
        expect(d.pruned).toBe(true);
        expect(d.reason).toContain("max value 'today' < query value 'zzz'");
        expect(d.reason).toContain('(predicate on String)');
    });

    it('covers every operator against the range', () => {
        expect(evaluate(dump, [p('eq', 'zzz')]).rowGroups.get(0)!.reason).toContain(
            "query value 'zzz' > max value 'today'"
        );
        expect(evaluate(dump, [p('eq', 'AAA')]).rowGroups.get(0)!.reason).toContain(
            "query value 'AAA' < min value 'Hello'"
        );
        expect(evaluate(dump, [p('lt', 'Hello')]).rowGroups.get(0)!.pruned).toBe(true);
        expect(evaluate(dump, [p('lte', 'Hello')]).rowGroups.get(0)!.pruned).toBe(false);
        expect(evaluate(dump, [p('lte', 'AAA')]).rowGroups.get(0)!.pruned).toBe(true);
        expect(evaluate(dump, [p('gt', 'today')]).rowGroups.get(0)!.pruned).toBe(true);
        expect(evaluate(dump, [p('gt', 'Hello')]).rowGroups.get(0)!.pruned).toBe(false);
        expect(evaluate(dump, [p('gte', 'today')]).rowGroups.get(0)!.pruned).toBe(false);
        expect(evaluate(dump, [p('gte', 'zzz')]).rowGroups.get(0)!.pruned).toBe(true);
    });

    it('reports missing statistics honestly', () => {
        const clone = structuredClone(dump);
        clone.metadata.row_groups[0]!.column_chunks['String']!.metadata.statistics = null;
        const d = evaluate(clone, [p('eq', 'Hello')]).rowGroups.get(0)!;
        expect(d).toEqual({
            pruned: false,
            reason: 'cannot prune — no statistics written (predicate on String)',
        });
    });

    it('reports an unsupported column type honestly, never guessing', () => {
        const clone = structuredClone(dump);
        // Strip the string declaration: BYTE_ARRAY becomes raw binary.
        const leaf = clone.metadata.schema_root.children!['String']!;
        leaf.logical_type = null;
        leaf.converted_type = null;
        const { rowGroups, pages } = evaluate(clone, [p('eq', 'Hello')]);
        expect(rowGroups.get(0)!.pruned).toBe(false);
        expect(rowGroups.get(0)!.reason).toContain('cannot prune — unsupported type');
        expect(pages.get('rg_0_col_String_data_0')!.reason).toContain(
            'cannot prune — unsupported type'
        );
    });

    it('reports undecodable statistics honestly', () => {
        const clone = structuredClone(dump);
        // Claim INT32 with 5-byte stat payloads: decode must refuse.
        (clone.metadata.schema_root.children!['String'] as SchemaLeaf).type = 'INT32';
        const d = evaluate(clone, [p('eq', '5')]).rowGroups.get(0)!;
        expect(d).toEqual({
            pruned: false,
            reason: 'cannot prune — statistics could not be decoded (predicate on String)',
        });
    });
});

describe('evaluate — AND composition', () => {
    const dump = loadStats();

    it('returns empty maps for zero predicates (nothing pruned)', () => {
        const { rowGroups, pages } = evaluate(dump, []);
        expect(rowGroups.size).toBe(0);
        expect(pages.size).toBe(0);
    });

    it('prunes when any predicate excludes, preserving the pruning reason', () => {
        const d = evaluate(dump, [p('eq', 'Hello'), p('gt', 'zzz')]).rowGroups.get(0)!;
        expect(d.pruned).toBe(true);
        expect(d.reason).toContain("max value 'today' < query value 'zzz'");
        expect(d.reason).toContain('(predicate on String)');
        // Kept reasons don't dilute a prune.
        expect(d.reason).not.toContain('overlaps');
    });

    it('keeps only when every predicate keeps, preserving each reason', () => {
        const d = evaluate(dump, [p('eq', 'Hello'), p('gte', 'today')]).rowGroups.get(0)!;
        expect(d.pruned).toBe(false);
        expect(d.reason).toContain('overlaps');
    });

    it('composes page decisions the same way', () => {
        const d = evaluate(dump, [p('eq', 'Hello'), p('gt', 'zzz')]).pages.get(
            'rg_0_col_String_data_0'
        )!;
        expect(d.pruned).toBe(true);
        expect(d.reason).toContain("max value 'today' < query value 'zzz'");
    });
});

describe('evaluate — pages (column index)', () => {
    const dump = loadStats();

    it('keys page decisions by the segment-tree node id of the page node', () => {
        const { pages } = evaluate(dump, [p('gt', 'zzz')]);
        expect(pages.size).toBe(1);
        const [key, decision] = [...pages.entries()][0]!;
        const node = findNode(project(dump), key);
        expect(node).not.toBeNull();
        expect(node!.kind).toBe('data_page');
        expect(decision.pruned).toBe(true);
        expect(decision.reason).toContain("max value 'today' < query value 'zzz'");
    });

    it('keeps the page when the range overlaps', () => {
        const d = evaluate(dump, [p('eq', 'Hello')]).pages.get('rg_0_col_String_data_0')!;
        expect(d.pruned).toBe(false);
        expect(d.reason).toContain('overlaps');
    });

    it('prunes an all-null page for any non-null-matching predicate', () => {
        const clone = structuredClone(dump);
        clone.column_chunks[0]!.column_index!.null_pages = [true];
        const d = evaluate(clone, [p('eq', 'Hello')]).pages.get('rg_0_col_String_data_0')!;
        expect(d.pruned).toBe(true);
        expect(d.reason).toContain('entirely null');
    });

    it('reports pages without a column index honestly', () => {
        const clone = structuredClone(dump);
        clone.column_chunks[0]!.column_index = null;
        const d = evaluate(clone, [p('eq', 'Hello')]).pages.get('rg_0_col_String_data_0')!;
        expect(d).toEqual({
            pruned: false,
            reason:
                'cannot prune — no column index written for this column chunk ' +
                '(predicate on String)',
        });
    });
});

describe('evaluate — metadata-only dumps', () => {
    it('makes row-group decisions only (no page nodes exist)', () => {
        const dump = loadMetadataExport();
        const { rowGroups, pages } = evaluate(dump, [p('gt', 'zzz')]);
        expect(rowGroups.size).toBe(dump.metadata.row_groups.length);
        expect(rowGroups.get(0)!.pruned).toBe(true);
        expect(pages.size).toBe(0);
    });
});

describe('evaluate — input errors', () => {
    const dump = loadStats();

    it('throws on an unknown column', () => {
        expect(() => evaluate(dump, [{ column: 'nope', op: 'eq', value: 'x' }])).toThrow(
            /unknown column/
        );
    });

    it('throws when the value does not parse for the column type', () => {
        const clone = structuredClone(dump);
        (clone.metadata.schema_root.children!['String'] as SchemaLeaf).type = 'INT32';
        expect(() => evaluate(clone, [p('eq', 'abc')])).toThrow(/not a valid INT32/);
    });
});

describe('isValidPredicate — live-state validity filtering', () => {
    const dump = loadStats();

    it('accepts a parseable value on a known column', () => {
        expect(isValidPredicate(dump, p('eq', 'Hello'))).toBe(true);
    });

    it('rejects an empty value (an incomplete row, not an error)', () => {
        expect(isValidPredicate(dump, p('eq', ''))).toBe(false);
    });

    it('rejects an unknown column', () => {
        expect(isValidPredicate(dump, { column: 'nope', op: 'eq', value: 'x' })).toBe(false);
    });

    it('rejects a value that does not parse for the column type', () => {
        const clone = structuredClone(dump);
        (clone.metadata.schema_root.children!['String'] as SchemaLeaf).type = 'INT32';
        expect(isValidPredicate(clone, p('eq', 'abc'))).toBe(false);
        expect(isValidPredicate(clone, p('eq', '5'))).toBe(true);
    });

    it('accepts unsupported column types — they evaluate to "cannot prune"', () => {
        const clone = structuredClone(dump);
        const leaf = clone.metadata.schema_root.children!['String']!;
        leaf.logical_type = null;
        leaf.converted_type = null;
        expect(isValidPredicate(clone, p('eq', 'Hello'))).toBe(true);
    });
});

describe('rowCounts', () => {
    const dump = loadStats();

    it('counts every row as kept when nothing is pruned', () => {
        expect(rowCounts(dump, evaluate(dump, []))).toEqual({ kept: 14, total: 14 });
        expect(rowCounts(dump, evaluate(dump, [p('eq', 'Hello')]))).toEqual({
            kept: 14,
            total: 14,
        });
    });

    it('excludes pruned row groups from kept (an upper bound, never exact)', () => {
        expect(rowCounts(dump, evaluate(dump, [p('gt', 'zzz')]))).toEqual({ kept: 0, total: 14 });
    });

    it('sums across multiple row groups', () => {
        const multi: unknown = JSON.parse(
            readFileSync(`${FIXTURES}sort_columns_expected.json`, 'utf8')
        );
        if (!validateFile(multi)) {
            throw new Error('sort_columns fixture failed schema validation');
        }
        const a = (op: Predicate['op'], value: string): Predicate => ({ column: 'a', op, value });
        expect(rowCounts(multi, evaluate(multi, []))).toEqual({ kept: 6, total: 6 });
        // Both row groups share the range [1,2]: a > 100 prunes them all.
        expect(rowCounts(multi, evaluate(multi, [a('gt', '100')]))).toEqual({
            kept: 0,
            total: 6,
        });
    });
});

describe('leafColumns', () => {
    it('lists leaf column paths from the schema', () => {
        expect(leafColumns(loadStats())).toEqual(['String']);
        expect(leafColumns(loadMetadataExport())).toEqual(['String']);
    });
});

describe('parseQueryState', () => {
    it('round-trips a valid state', () => {
        const state = { predicates: [p('gt', 'zzz')], columns: ['String'] };
        expect(parseQueryState(JSON.stringify(state))).toEqual(state);
    });

    it('accepts zero predicates', () => {
        expect(parseQueryState('{"predicates":[],"columns":[]}')).toEqual({
            predicates: [],
            columns: [],
        });
    });

    it('rejects malformed input', () => {
        expect(parseQueryState('not json')).toBeNull();
        expect(parseQueryState('null')).toBeNull();
        expect(parseQueryState('{"predicates":[],"columns":"String"}')).toBeNull();
        expect(parseQueryState('{"predicates":[{"column":"String"}],"columns":[]}')).toBeNull();
        // The old single-predicate shape never shipped: no back-compat.
        expect(parseQueryState('{"column":"String","op":"gt","value":"zzz"}')).toBeNull();
    });
});

describe('columnStats', () => {
    const dump = loadStats();

    it('decodes the file-level range, null count, and type for a supported column', () => {
        expect(columnStats(dump, 'String')).toEqual({
            physicalType: 'BYTE_ARRAY',
            logicalType: 'STRING',
            unsupported: null,
            min: 'Hello',
            max: 'today',
            nullCount: 0,
        });
    });

    it('returns null for an unknown column', () => {
        expect(columnStats(dump, 'nope')).toBeNull();
    });

    it('reports an unsupported type honestly, with no decoded range', () => {
        const clone = structuredClone(dump);
        const leaf = clone.metadata.schema_root.children!['String']!;
        leaf.logical_type = null;
        leaf.converted_type = null;
        const stats = columnStats(clone, 'String')!;
        expect(stats.unsupported).toContain('raw binary');
        expect(stats.min).toBeUndefined();
        expect(stats.max).toBeUndefined();
    });

    it('sums null counts across row groups, or reports unknown when any chunk omits it', () => {
        const clone = structuredClone(dump);
        clone.metadata.row_groups[0]!.column_chunks['String']!.metadata.statistics!.null_count =
            null;
        expect(columnStats(clone, 'String')!.nullCount).toBeNull();
    });
});
