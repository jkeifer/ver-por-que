import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateFile, validateMetadata } from '../src/generated/validate.js';
import { diffDumps } from '../src/business/diff';
import type { AnyDump } from '../src/types';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

function load(name: string): AnyDump {
    const dump: unknown = JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8'));
    const valid = name === 'metadata-export.json' ? validateMetadata(dump) : validateFile(dump);
    if (!valid) {
        throw new Error(`${name} failed schema validation`);
    }
    return dump as AnyDump;
}

// One row group, one String column: 152 compressed GZIP in the stats
// fixture, 199 UNCOMPRESSED in the with_length fixture. Same underlying data.
const stats = load('data_index_bloom_encoding_stats_expected.json');
const withLength = load('data_index_bloom_encoding_with_length_expected.json');
// Two row groups x two columns (a, b), all SNAPPY.
const sortColumns = load('sort_columns_expected.json');

describe('diffDumps', () => {
    it('a file against itself: zero deltas, nothing added or removed', () => {
        const diff = diffDumps(stats, stats);
        expect(diff.added).toEqual([]);
        expect(diff.removed).toEqual([]);
        expect(diff.chunks).toHaveLength(1);
        expect(diff.chunks.every(c => c.delta === 0)).toBe(true);
        expect(diff.chunks.every(c => c.codecA === c.codecB)).toBe(true);
        expect(diff.rowGroups.every(rg => rg.delta === 0)).toBe(true);
        expect(diff.total.delta).toBe(0);
        expect(diff.total.rowsA).toBe(diff.total.rowsB);
    });

    it('the two bloom fixtures: one aligned chunk with the known delta', () => {
        const diff = diffDumps(stats, withLength);
        expect(diff.added).toEqual([]);
        expect(diff.removed).toEqual([]);
        expect(diff.chunks).toHaveLength(1);

        const chunk = diff.chunks[0]!;
        expect(chunk).toMatchObject({
            rowGroup: 0,
            column: 'String',
            compressedA: 152,
            compressedB: 199,
            delta: 47,
            uncompressedA: 163,
            uncompressedB: 199,
            codecA: 'GZIP',
            codecB: 'UNCOMPRESSED',
        });
        expect(chunk.encodingsA).toContain('PLAIN');
        expect(chunk.encodingsB).toContain('RLE_DICTIONARY');

        expect(diff.rowGroups).toEqual([
            { rowGroup: 0, compressedA: 152, compressedB: 199, delta: 47, rowsA: 14, rowsB: 14 },
        ]);
        expect(diff.total).toEqual({
            compressedA: 152,
            compressedB: 199,
            delta: 47,
            rowsA: 14,
            rowsB: 14,
        });
    });

    it('mismatched schemas: unmatched paths listed as added/removed', () => {
        const diff = diffDumps(stats, sortColumns);
        expect(diff.chunks).toEqual([]);
        expect(diff.removed).toEqual(['rg 0 · String']);
        expect(diff.added.sort()).toEqual(['rg 0 · a', 'rg 0 · b', 'rg 1 · a', 'rg 1 · b']);

        // Row group 1 exists only in B: rowsA is null, sizes still totalled.
        expect(diff.rowGroups).toHaveLength(2);
        expect(diff.rowGroups[0]).toMatchObject({ rowsA: 14, rowsB: 3, compressedA: 152 });
        expect(diff.rowGroups[1]).toMatchObject({ rowsA: null, rowsB: 3, compressedA: 0 });
        expect(diff.total.compressedA).toBe(152);
        expect(diff.total.compressedB).toBe(348); // (104 + 70) * 2
        expect(diff.total.rowsA).toBe(14);
        expect(diff.total.rowsB).toBe(6);
    });

    it('mixing a metadata-only export with a full dump works', () => {
        // The metadata export carries the with_length footer (199, UNCOMPRESSED).
        const diff = diffDumps(load('metadata-export.json'), stats);
        expect(diff.chunks).toHaveLength(1);
        expect(diff.chunks[0]!).toMatchObject({
            compressedA: 199,
            compressedB: 152,
            delta: -47,
            codecA: 'UNCOMPRESSED',
            codecB: 'GZIP',
        });
    });
});
