/**
 * The query engine's resolved model (pure, no DOM).
 *
 * `pruning.ts` answers the low-level statistics question — "can predicate P
 * prove segment S can't match?" This module answers the question every UI
 * surface actually asks: "under THIS query, what happens to segment S — is it
 * read, read-only-to-test-a-predicate, skipped by projection, or pruned by
 * statistics?" That single 5-way decision, the read summary, and the dimming
 * set all live here, computed once, so the matrix, the info panel, the summary
 * card, and the visualizers never re-derive query semantics independently.
 *
 * The heart is ONE precedence ladder (§ below), shared by `chunkStatus` (the
 * row-group × column matrix cell) and `pageStatus` (the same, plus the page's
 * own column-index verdict). `resolve` walks the segment tree once and hangs a
 * `SegmentStatus` on every data-bearing node from that ladder — no id-string
 * parsing, no per-consumer logic.
 */
import { evaluate, leafColumns, rowCounts, type Decision, type QueryState } from './pruning';
import type { Evaluation } from './pruning';
import type { SegmentNode } from './segment-tree';
import type { AnyDump } from '../types';

/** The resolved fate of one physical segment under a query. Discriminated. */
export type SegmentStatus =
    | { kind: 'read'; reason: string } // read AND returned
    | { kind: 'eval-only'; reason: string } // read only to test a predicate
    | { kind: 'not-selected'; reason: string } // never read (not projected)
    | { kind: 'pruned'; reason: string }; // skipped by statistics

/** A count pair rendered as "<read> of <total>". */
export interface Count {
    read: number;
    total: number;
}

/** Aggregate read summary, computed entirely in the core. */
export interface ReadSummary {
    /** "up to kept of total" — pruning is an upper bound, never exact. */
    rows: { kept: number; total: number };
    rowGroups: Count;
    columnChunks: Count;
    /** null when there are no page nodes (metadata-only export). */
    pages: Count | null;
    /** total = filesize (metadata/footer/index overhead all count as read). */
    bytes: Count;
    /** Honest degradation note, or null. */
    note: string | null;
}

/** Everything the precedence needs; built once per resolve. */
export interface QueryContext {
    /** Columns selected for output (the SELECT list). */
    projected: Set<string>;
    /** Columns any valid predicate touches (read even when not projected). */
    predicateColumns: Set<string>;
    /** Statistics decisions from pruning.evaluate(). */
    evaluation: Evaluation;
}

// --- Reason wording (composed here so all surfaces read identically) ---------
//
// Outcome-first and friendly. Raw engine "cannot prune …" text is internal; it
// only surfaces (appended to a kept/eval reason) when a predicate on the column
// actually influenced the outcome — never as noise on a plainly-read chunk.

const notSelected = (): SegmentStatus => ({
    kind: 'not-selected',
    reason: 'Not read — column not selected for output.',
});

const prunedRowGroup = (d: Decision): SegmentStatus => ({
    kind: 'pruned',
    reason: `Skipped — ${d.reason}`,
});

const prunedPage = (d: Decision): SegmentStatus => ({
    kind: 'pruned',
    reason: `Skipped — page pruned by column index: ${d.reason}`,
});

const evalOnly = (d: Decision | undefined): SegmentStatus => ({
    kind: 'eval-only',
    reason: d
        ? `Read only to evaluate a predicate; ${d.reason}`
        : 'Read only to evaluate a predicate.',
});

const read = (predicate: boolean, d: Decision | undefined): SegmentStatus => ({
    kind: 'read',
    reason: predicate && d ? `Read and returned. ${d.reason}` : 'Read and returned.',
});

// --- The single precedence ---------------------------------------------------

/**
 * Column-chunk (row group × column) cell — the matrix precedence, minus pages.
 * Ladder, in order:
 *   1. neither projected nor under a predicate → not-selected (never read; even
 *      inside a pruned row group skipping it saves nothing).
 *   2. the row group is pruned by footer statistics → pruned.
 *   3. a predicate-only column (touched but not projected) → eval-only.
 *   4. else → read.
 */
export function chunkStatus(ctx: QueryContext, rg: number, column: string): SegmentStatus {
    const projected = ctx.projected.has(column);
    const predicate = ctx.predicateColumns.has(column);
    if (!projected && !predicate) {
        return notSelected();
    }
    const rgDecision = ctx.evaluation.rowGroups.get(rg);
    if (rgDecision?.pruned) {
        return prunedRowGroup(rgDecision);
    }
    if (!projected) {
        return evalOnly(rgDecision);
    }
    return read(predicate, rgDecision);
}

/**
 * Page cell — the same ladder with the page's own column-index verdict spliced
 * in as rung 2 (a data page pruned by its column index is skipped even when its
 * chunk is otherwise read). A pruned ROW GROUP (rung 3) still dominates: the
 * reader skips the whole group before any page-level decision matters, so
 * rung 2 only fires inside a kept row group.
 */
export function pageStatus(
    ctx: QueryContext,
    rg: number,
    column: string,
    pageId: string
): SegmentStatus {
    const projected = ctx.projected.has(column);
    const predicate = ctx.predicateColumns.has(column);
    if (!projected && !predicate) {
        return notSelected();
    }
    const pageDecision = ctx.evaluation.pages.get(pageId);
    if (pageDecision?.pruned) {
        return prunedPage(pageDecision);
    }
    const rgDecision = ctx.evaluation.rowGroups.get(rg);
    if (rgDecision?.pruned) {
        return prunedRowGroup(rgDecision);
    }
    if (!projected) {
        return evalOnly(rgDecision);
    }
    return read(predicate, rgDecision);
}

/** A whole row group: pruned by statistics, or read. */
function rowGroupStatus(ctx: QueryContext, rg: number): SegmentStatus {
    const d = ctx.evaluation.rowGroups.get(rg);
    return d?.pruned ? prunedRowGroup(d) : read(true, d);
}

/** Build the precedence context for a query. Used by `resolve` and by tests. */
export function buildContext(dump: AnyDump, state: QueryState): QueryContext {
    return {
        projected: new Set(state.columns),
        predicateColumns: new Set(state.predicates.map(p => p.column)),
        evaluation: evaluate(dump, state.predicates),
    };
}

const DIMMED_KINDS: ReadonlySet<SegmentStatus['kind']> = new Set(['pruned', 'not-selected']);

const isRead = (s: SegmentStatus): boolean => s.kind === 'read' || s.kind === 'eval-only';

/** Bytes a chunk occupies: footer's compressed size, falling back to the physical span. */
const chunkBytes = (node: Extract<SegmentNode, { kind: 'column_chunk' }>): number =>
    node.meta?.total_compressed_size ?? node.chunk?.total_byte_size ?? 0;

/**
 * An immutable, query-aware view of the structure. Thrown away and rebuilt on
 * every edit — it carries no mutable state. It is a class (not a bare object)
 * only for `matrixCell`, which must run the precedence for (rg, column) pairs
 * that have NO node in the tree (sparse columns the matrix still renders).
 */
export class Resolution {
    /** Node ids to dim: every node whose status is not-selected or pruned. */
    readonly dimmed: Set<string>;
    /** True when the query is non-default (something is actually overlaid). */
    readonly active: boolean;

    constructor(
        readonly state: QueryState,
        readonly summary: ReadSummary,
        private readonly statuses: Map<string, SegmentStatus>,
        private readonly ctx: QueryContext,
        active: boolean
    ) {
        this.active = active;
        this.dimmed = new Set(
            [...statuses].filter(([, s]) => DIMMED_KINDS.has(s.kind)).map(([id]) => id)
        );
    }

    /**
     * Status for a node id. undefined for kinds the query says nothing about
     * (magic, schema, footer, metadata regions, indexes, bloom) — those are
     * always read or simply irrelevant to what a predicate skips.
     */
    statusOf(id: string): SegmentStatus | undefined {
        return this.statuses.get(id);
    }

    /**
     * Status for any (rg, column) pair — including cells with no chunk node.
     * Backs the matrix, which renders a full grid even where a column is absent
     * from a row group.
     */
    matrixCell(rg: number, column: string): SegmentStatus {
        return chunkStatus(this.ctx, rg, column);
    }
}

const METADATA_ONLY_NOTE =
    'Page and byte detail come from a full dump; this is a metadata-only export.';

/**
 * Build the resolved model. Pure and deterministic: one walk of `tree` assigns
 * every data-bearing node its status and, in the same pass, accumulates the
 * read summary. `state.predicates` must already be valid (the panel filters
 * incomplete rows before calling; `evaluate` throws on an unknown column or an
 * unparseable value).
 */
export function resolve(dump: AnyDump, tree: SegmentNode, state: QueryState): Resolution {
    const ctx = buildContext(dump, state);
    const statuses = new Map<string, SegmentStatus>();

    let rowGroupsRead = 0;
    let columnChunksTotal = 0;
    let columnChunksRead = 0;
    let pagesTotal = 0;
    let pagesRead = 0;
    // Bytes we can PROVE are skipped; everything else counts as read.
    let skippedChunkBytes = 0;
    let skippedPageBytes = 0;

    // rg carries the current row-group index down; chunk carries the owning
    // column-chunk's status down to its pages (a page's own bytes are only
    // subtractable when its chunk is otherwise read — else the whole chunk's
    // bytes are already counted as skipped).
    const walk = (node: SegmentNode, rg: number, chunk: SegmentStatus | null): void => {
        switch (node.kind) {
            case 'row_group': {
                const s = rowGroupStatus(ctx, node.index);
                statuses.set(node.id, s);
                if (s.kind === 'read') {
                    rowGroupsRead += 1;
                }
                node.children.forEach(c => walk(c, node.index, chunk));
                return;
            }
            case 'column_chunk': {
                const s = chunkStatus(ctx, rg, node.name);
                statuses.set(node.id, s);
                columnChunksTotal += 1;
                if (isRead(s)) {
                    columnChunksRead += 1;
                } else {
                    skippedChunkBytes += chunkBytes(node);
                }
                node.children.forEach(c => walk(c, rg, s));
                return;
            }
            case 'dictionary_page':
            case 'data_page':
            case 'index_page': {
                const s = pageStatus(ctx, rg, node.path, node.id);
                statuses.set(node.id, s);
                pagesTotal += 1;
                if (isRead(s)) {
                    pagesRead += 1;
                } else if (s.kind === 'pruned' && chunk !== null && isRead(chunk)) {
                    // Page pruned inside an otherwise-read chunk: subtract just
                    // this page's bytes (page-granular), so byte % and page %
                    // agree. header_size + compressed_page_size are required on
                    // every page kind.
                    skippedPageBytes += node.page.header_size + node.page.compressed_page_size;
                }
                return;
            }
            default:
                node.children.forEach(c => walk(c, rg, chunk));
        }
    };
    walk(tree, -1, null);

    const rows = rowCounts(dump, ctx.evaluation);
    const total = dump.filesize;
    const summary: ReadSummary = {
        rows,
        rowGroups: { read: rowGroupsRead, total: dump.metadata.row_groups.length },
        columnChunks: { read: columnChunksRead, total: columnChunksTotal },
        pages: pagesTotal === 0 ? null : { read: pagesRead, total: pagesTotal },
        bytes: { read: total - skippedChunkBytes - skippedPageBytes, total },
        note: pagesTotal === 0 ? METADATA_ONLY_NOTE : null,
    };

    const allColumns = leafColumns(dump).length;
    const active = state.predicates.length > 0 || state.columns.length !== allColumns;

    return new Resolution(state, summary, statuses, ctx, active);
}
