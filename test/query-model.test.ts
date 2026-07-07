import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateFile, validateMetadata } from '../src/generated/validate.js';
import {
    evaluate,
    type Evaluation,
    type Predicate,
    type QueryState,
} from '../src/business/pruning';
import { project, prunedClosure, type SegmentNode } from '../src/business/segment-tree';
import {
    buildContext,
    chunkStatus,
    pageStatus,
    resolve,
    type QueryContext,
} from '../src/business/query-model';
import type { Dump, MetadataDump } from '../src/types';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

// 1 row group, 1 String column, 1 data page; footer stats and column index
// both cover ['Hello', 'today'].
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
const state = (predicates: Predicate[], columns: string[]): QueryState => ({ predicates, columns });

const PAGE_ID = 'rg_0_col_String_data_0';

/** Hand-built context, to isolate one rung of the ladder at a time. */
function ctx(
    projected: string[],
    predicateColumns: string[],
    evaluation: Evaluation
): QueryContext {
    return {
        projected: new Set(projected),
        predicateColumns: new Set(predicateColumns),
        evaluation,
    };
}

describe('precedence — chunkStatus / pageStatus', () => {
    const dump = loadStats();

    it('rung 1: neither projected nor predicated → not-selected (even when the RG is pruned)', () => {
        // Row group pruned by the evaluation, yet the cell is neither projected
        // nor under a predicate: rung 1 dominates rung 2/3.
        const c = ctx([], [], evaluate(dump, [p('gt', 'zzz')]));
        expect(chunkStatus(c, 0, 'String').kind).toBe('not-selected');
        expect(pageStatus(c, 0, 'String', PAGE_ID).kind).toBe('not-selected');
    });

    it('rung 2 (pages only): a page pruned by its column index → pruned, even in a kept RG', () => {
        const evaluation: Evaluation = {
            rowGroups: new Map([[0, { pruned: false, reason: 'kept — overlaps' }]]),
            pages: new Map([[PAGE_ID, { pruned: true, reason: 'pruned — page x' }]]),
        };
        const c = ctx(['String'], [], evaluation);
        const s = pageStatus(c, 0, 'String', PAGE_ID);
        expect(s.kind).toBe('pruned');
        expect(s.reason).toContain('page pruned by column index');
        // The chunk cell has no page rung, so it reads.
        expect(chunkStatus(c, 0, 'String').kind).toBe('read');
    });

    it('rung 3: a projected column in a statistics-pruned RG → pruned', () => {
        const c = buildContext(dump, state([p('gt', 'zzz')], ['String']));
        const s = chunkStatus(c, 0, 'String');
        expect(s.kind).toBe('pruned');
        expect(s.reason).toContain('Skipped —');
        expect(s.reason).toContain("max value 'today' < query value 'zzz'");
        expect(pageStatus(c, 0, 'String', PAGE_ID).kind).toBe('pruned');
    });

    it('rung 4: a predicate-only column (not projected) in a kept RG → eval-only', () => {
        const c = buildContext(dump, state([p('eq', 'Hello')], []));
        const s = chunkStatus(c, 0, 'String');
        expect(s.kind).toBe('eval-only');
        expect(s.reason).toContain('Read only to evaluate a predicate');
    });

    it('rung 5: a projected column in a kept RG → read', () => {
        const c = buildContext(dump, state([], ['String']));
        expect(chunkStatus(c, 0, 'String')).toEqual({ kind: 'read', reason: 'Read and returned.' });
    });

    it('read surfaces the decision only when a predicate on the column applies', () => {
        const c = buildContext(dump, state([p('eq', 'Hello')], ['String']));
        const s = chunkStatus(c, 0, 'String');
        expect(s.kind).toBe('read');
        expect(s.reason).toContain('Read and returned.');
        expect(s.reason).toContain('overlaps');
    });

    it('multi-predicate AND: a value pruned by one predicate flows through as pruned', () => {
        const c = buildContext(dump, state([p('eq', 'Hello'), p('gt', 'zzz')], ['String']));
        const s = chunkStatus(c, 0, 'String');
        expect(s.kind).toBe('pruned');
        expect(s.reason).toContain("max value 'today' < query value 'zzz'");
    });
});

describe('resolve / Resolution — status assignment', () => {
    const dump = loadStats();
    const tree = project(dump);

    it('assigns status to row_group, column_chunk, and page nodes; nothing else', () => {
        const r = resolve(dump, tree, state([], ['String']));
        expect(r.statusOf('rg_0')?.kind).toBe('read');
        expect(r.statusOf('rg_0_col_String')?.kind).toBe('read');
        expect(r.statusOf(PAGE_ID)?.kind).toBe('read');
        // Non-data kinds get no status.
        expect(r.statusOf('schema_root')).toBeUndefined();
        expect(r.statusOf('footer')).toBeUndefined();
        expect(r.statusOf('magic_header')).toBeUndefined();
    });

    it('active is false for the default state and true otherwise', () => {
        expect(resolve(dump, tree, state([], ['String'])).active).toBe(false);
        expect(resolve(dump, tree, state([], [])).active).toBe(true);
        expect(resolve(dump, tree, state([p('eq', 'Hello')], ['String'])).active).toBe(true);
    });
});

describe('resolve / Resolution — dimmed (prunedClosure parity)', () => {
    const dump = loadStats();
    const tree = project(dump);

    it('dims a pruned RG plus its chunk and pages — matching the old prunedClosure', () => {
        const r = resolve(dump, tree, state([p('gt', 'zzz')], ['String']));
        expect(r.dimmed.has('rg_0')).toBe(true);
        expect(r.dimmed.has('rg_0_col_String')).toBe(true);
        expect(r.dimmed.has(PAGE_ID)).toBe(true);
        // Every descendant the old closure would dim is dimmed here too.
        for (const id of prunedClosure(tree, new Set(['rg_0']))) {
            expect(r.dimmed.has(id), id).toBe(true);
        }
    });

    it('dims a not-selected chunk and its pages (projection dimming)', () => {
        const r = resolve(dump, tree, state([], []));
        expect(r.dimmed.has('rg_0_col_String')).toBe(true);
        expect(r.dimmed.has(PAGE_ID)).toBe(true);
        // The row group itself is still read (nothing pruned it).
        expect(r.dimmed.has('rg_0')).toBe(false);
    });
});

describe('resolve / Resolution — matrixCell', () => {
    const dump = loadStats();
    const r = resolve(dump, project(dump), state([], ['String']));

    it('returns a status for an (rg, column) pair with no node', () => {
        // No such column node exists; the ladder still resolves it.
        expect(r.matrixCell(0, 'Nonexistent').kind).toBe('not-selected');
        // No such row group; a projected column with no RG decision reads.
        expect(r.matrixCell(9, 'String').kind).toBe('read');
    });
});

describe('ReadSummary', () => {
    const dump = loadStats();
    const tree = project(dump);
    const chunkBytes =
        dump.metadata.row_groups[0]!.column_chunks['String']!.metadata.total_compressed_size;

    it('full dump, no predicates, all columns: everything read, bytes == filesize', () => {
        const { summary } = resolve(dump, tree, state([], ['String']));
        expect(summary.rowGroups).toEqual({ read: 1, total: 1 });
        expect(summary.columnChunks).toEqual({ read: 1, total: 1 });
        expect(summary.pages).toEqual({ read: 1, total: 1 });
        expect(summary.bytes).toEqual({ read: dump.filesize, total: dump.filesize });
        expect(summary.note).toBeNull();
    });

    it('deselect the only column: chunk unread, chunk bytes subtracted', () => {
        const { summary } = resolve(dump, tree, state([], []));
        expect(summary.columnChunks.read).toBe(0);
        expect(summary.pages).toEqual({ read: 0, total: 1 });
        expect(summary.bytes.read).toBe(dump.filesize - chunkBytes);
    });

    it('a predicate that prunes the RG: no groups read, zero rows kept', () => {
        const { summary } = resolve(dump, tree, state([p('gt', 'zzz')], ['String']));
        expect(summary.rowGroups.read).toBe(0);
        expect(summary.rows.kept).toBe(0);
        expect(summary.bytes.read).toBe(dump.filesize - chunkBytes);
    });

    it('page-granular bytes: a pruned page inside a read chunk subtracts only its own bytes', () => {
        // Mark the single data page entirely null: its column-index decision
        // prunes it while the footer stats keep the (projected) row group. The
        // chunk is READ, so only the page's bytes come off — not the whole chunk.
        const clone = structuredClone(dump);
        clone.column_chunks[0]!.column_index!.null_pages = [true];
        const page = clone.column_chunks[0]!.data_pages[0]!;
        const pageBytes = page.header_size + page.compressed_page_size;

        const { summary } = resolve(clone, project(clone), state([p('eq', 'Hello')], ['String']));
        // The chunk is READ (counted, not skipped) yet its pruned page's bytes
        // still come off — proof the subtraction is page-granular, coming from
        // the page path rather than a whole-chunk skip.
        expect(summary.columnChunks.read).toBe(1);
        expect(summary.pages).toEqual({ read: 0, total: 1 });
        expect(pageBytes).toBeGreaterThan(0);
        expect(summary.bytes.read).toBe(clone.filesize - pageBytes);
    });

    it('metadata-only export: pages null, note set, bytes still computed', () => {
        const meta = loadMetadataExport();
        const { summary } = resolve(meta, project(meta), state([], ['String']));
        expect(summary.pages).toBeNull();
        expect(summary.note).not.toBeNull();
        expect(summary.bytes).toEqual({ read: meta.filesize, total: meta.filesize });
    });
});

// Guard the assumption the whole module leans on: every page node the walk
// visits actually carries a rowGroup after the Step 1 change.
describe('segment-tree Step 1 — page rowGroup', () => {
    it('every page node carries its row-group index', () => {
        const pages: SegmentNode[] = [];
        const walk = (n: SegmentNode): void => {
            if (n.kind === 'dictionary_page' || n.kind === 'data_page' || n.kind === 'index_page') {
                pages.push(n);
            }
            n.children.forEach(walk);
        };
        walk(project(loadStats()));
        expect(pages.length).toBeGreaterThan(0);
        for (const n of pages) {
            expect(n.kind !== 'file' && 'rowGroup' in n && n.rowGroup).toBe(0);
        }
    });
});
