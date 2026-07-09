/**
 * Predicate-pushdown pruning engine (pure, no DOM).
 *
 * Simulates what a reader would skip for a conjunction (AND) of predicates:
 * row groups via footer column statistics, pages via the column index. A
 * segment is pruned when ANY predicate proves it can't match; every decision
 * carries a stated reason, annotated with the predicate's column. Unsupported
 * types and missing statistics report "cannot prune" — the engine never
 * guesses. Page decisions are keyed by the segment-tree node id of the page
 * node so the UI can dim rects directly.
 */
import { findSchemaLeaf } from './segment-tree';
import {
    decodeStatValue,
    parsePredicateValue,
    unsupportedReason,
    type StatValue,
} from './stat-values';
import type { AnyDump, ColumnStatistics, SchemaLeaf, SchemaGroup, SchemaRoot } from '../types';

export type Op = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';

// prettier-ignore
export const OP_LABEL: Record<Op, string> = { eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥' };

export function isOp(v: unknown): v is Op {
    return typeof v === 'string' && v in OP_LABEL;
}

export interface Predicate {
    column: string;
    op: Op;
    value: string;
}

/**
 * Bloom outcomes for ONE `eq` predicate: the row groups the column's bloom
 * filter proved absent (a "miss" — safe to prune, a skip min/max couldn't make)
 * and those it couldn't rule out (a "hit" — maybe present). A bloom filter is an
 * equality membership test, so this only ever comes from `eq` predicates. Keyed
 * by the predicate's index in the query in `BloomResults`.
 */
export interface BloomOutcome {
    misses: Set<number>;
    hits: Set<number>;
}

/** Per-predicate bloom outcomes, keyed by the predicate's index in the query. */
export type BloomResults = Map<number, BloomOutcome>;

export type Decision = { pruned: boolean; reason: string };

export interface Evaluation {
    /** AND-composed footer-statistics decision per row group index. */
    rowGroups: Map<number, Decision>;
    /** AND-composed column-index decision per page, keyed by segment-tree node id. */
    pages: Map<string, Decision>;
}

/** A runnable query: predicates (ANDed) plus the output-column projection. */
export interface QueryState {
    predicates: Predicate[];
    columns: string[];
}

/** Parse a permalink-carried query state; anything malformed returns null. */
export function parseQueryState(text: string): QueryState | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    const s = parsed as { predicates?: unknown; columns?: unknown } | null;
    if (!Array.isArray(s?.predicates) || !Array.isArray(s.columns)) {
        return null;
    }
    const isPredicate = (p: unknown): p is Predicate => {
        const q = p as { column?: unknown; op?: unknown; value?: unknown } | null;
        return typeof q?.column === 'string' && isOp(q.op) && typeof q.value === 'string';
    };
    if (!s.predicates.every(isPredicate) || !s.columns.every(c => typeof c === 'string')) {
        return null;
    }
    return { predicates: s.predicates, columns: s.columns as string[] };
}

/** Leaf column paths in schema order (the columns a predicate can target). */
export function leafColumns(dump: AnyDump): string[] {
    const out: string[] = [];
    const walk = (node: SchemaRoot | SchemaGroup | SchemaLeaf): void => {
        if ('type' in node) {
            out.push(node.full_path);
            return;
        }
        Object.values(node.children ?? {}).forEach(walk);
    };
    walk(dump.metadata.schema_root);
    return out;
}

/** Display form of a value in a reason sentence (strings quoted). */
export function formatStatValue(v: StatValue): string {
    return typeof v === 'string' ? `'${v}'` : String(v);
}
const fmt = formatStatValue;

/** File-level footer statistics for one leaf column, for building a query. */
export interface ColumnStats {
    physicalType: string;
    /** Logical (or converted) type annotation, or null when plain physical. */
    logicalType: string | null;
    /** Why the statistics can't be decoded, or null when they can. */
    unsupported: string | null;
    /** Decoded range across all row groups; undefined when unavailable. */
    min?: StatValue;
    max?: StatValue;
    /** Total null count across row groups; null when any chunk omits it. */
    nullCount: number | null;
}

/** Aggregate a column's footer statistics across row groups (null: unknown column). */
export function columnStats(dump: AnyDump, column: string): ColumnStats | null {
    const leaf = findSchemaLeaf(dump.metadata.schema_root, column);
    if (!leaf) {
        return null;
    }
    const out: ColumnStats = {
        physicalType: leaf.type,
        logicalType: leaf.logical_type?.logical_type ?? leaf.converted_type ?? null,
        unsupported: unsupportedReason(leaf),
        nullCount: 0,
    };
    for (const group of dump.metadata.row_groups) {
        const stats = group.column_chunks[column]?.metadata.statistics;
        out.nullCount =
            out.nullCount === null || stats?.null_count === null || stats?.null_count === undefined
                ? null
                : out.nullCount + stats.null_count;
        if (
            out.unsupported !== null ||
            stats?.min_value === null ||
            stats?.min_value === undefined ||
            stats.max_value === null ||
            stats.max_value === undefined
        ) {
            continue;
        }
        const min = decodeStatValue(stats.min_value, leaf);
        const max = decodeStatValue(stats.max_value, leaf);
        if (min === undefined || max === undefined) {
            continue;
        }
        if (out.min === undefined || lt(min, out.min)) {
            out.min = min;
        }
        if (out.max === undefined || lt(out.max, max)) {
            out.max = max;
        }
    }
    return out;
}

/**
 * Can this predicate evaluate right now? Known column and a non-empty value
 * that parses for the column's type. Unsupported-type columns pass with any
 * non-empty value — they evaluate honestly to "cannot prune". The live
 * builder excludes invalid rows instead of erroring while the user types.
 */
export function isValidPredicate(dump: AnyDump, p: Predicate): boolean {
    const leaf = findSchemaLeaf(dump.metadata.schema_root, p.column);
    if (!leaf || p.value === '') {
        return false;
    }
    return unsupportedReason(leaf) !== null || parsePredicateValue(p.value, leaf) !== undefined;
}

/**
 * Row counts under an evaluation: total across all row groups, and the sum
 * over KEPT row groups. Kept is an upper bound — statistics pruning proves
 * rows CAN'T match, never that the remaining rows do.
 */
export function rowCounts(dump: AnyDump, evaluation: Evaluation): { kept: number; total: number } {
    let kept = 0;
    let total = 0;
    dump.metadata.row_groups.forEach((group, index) => {
        total += group.row_count;
        if (!(evaluation.rowGroups.get(index)?.pruned ?? false)) {
            kept += group.row_count;
        }
    });
    return { kept, total };
}

const NO_STATS: Decision = { pruned: false, reason: 'cannot prune — no statistics written' };

const cannot = (why: string): Decision => ({ pruned: false, reason: `cannot prune — ${why}` });

/**
 * a < b for same-typed decoded values. Booleans order false < true; the
 * casts satisfy TS — min/max/query are always the same runtime type here.
 */
function lt(a: StatValue, b: StatValue): boolean {
    const na = typeof a === 'boolean' ? Number(a) : a;
    const nb = typeof b === 'boolean' ? Number(b) : b;
    return (na as number) < (nb as number);
}

/** a == b for same-typed decoded values (neither is less than the other). */
function eq(a: StatValue, b: StatValue): boolean {
    return !lt(a, b) && !lt(b, a);
}

/** Prune/keep against a [min, max] range. All ops here never match null. */
function decide(min: StatValue, max: StatValue, op: Op, v: StatValue): Decision {
    const pruned = (reason: string): Decision => ({ pruned: true, reason: `pruned — ${reason}` });
    switch (op) {
        case 'eq':
            if (lt(v, min)) {
                return pruned(`query value ${fmt(v)} < min value ${fmt(min)}`);
            }
            if (lt(max, v)) {
                return pruned(`query value ${fmt(v)} > max value ${fmt(max)}`);
            }
            break;
        case 'ne':
            // ≠ can only skip a range that is the single value v (min==max==v);
            // any other range holds some value that differs, so it's never
            // pruned — the point of surfacing ≠ is showing it almost never helps.
            if (eq(min, max) && eq(min, v)) {
                return pruned(`every value equals ${fmt(v)}; nothing in the range is ≠ ${fmt(v)}`);
            }
            return {
                pruned: false,
                reason: `kept — a ≠ predicate can't skip a range; values other than ${fmt(v)} may exist in [${fmt(min)},${fmt(max)}]`,
            };
        case 'lt':
            if (!lt(min, v)) {
                return pruned(
                    `min value ${fmt(min)} ${lt(v, min) ? '>' : '='} query value ${fmt(v)}; nothing can be < ${fmt(v)}`
                );
            }
            break;
        case 'lte':
            if (lt(v, min)) {
                return pruned(`min value ${fmt(min)} > query value ${fmt(v)}`);
            }
            break;
        case 'gt':
            if (!lt(v, max)) {
                return pruned(
                    `max value ${fmt(max)} ${lt(max, v) ? '<' : '='} query value ${fmt(v)}; nothing can be > ${fmt(v)}`
                );
            }
            break;
        case 'gte':
            if (lt(max, v)) {
                return pruned(`max value ${fmt(max)} < query value ${fmt(v)}`);
            }
            break;
    }
    return {
        pruned: false,
        reason: `kept — range [${fmt(min)},${fmt(max)}] overlaps query`,
    };
}

function decideStats(
    stats: ColumnStatistics | null | undefined,
    numValues: number | undefined,
    leaf: SchemaLeaf,
    op: Op,
    v: StatValue
): Decision {
    const nullCount = stats?.null_count ?? null;
    if (nullCount !== null && numValues !== undefined && nullCount >= numValues) {
        return {
            pruned: true,
            reason: `pruned — all ${numValues} values are null; a ${OP_LABEL[op]} predicate never matches null`,
        };
    }
    if (
        stats?.min_value === null ||
        stats?.min_value === undefined ||
        stats.max_value === null ||
        stats.max_value === undefined
    ) {
        return NO_STATS;
    }
    const min = decodeStatValue(stats.min_value, leaf);
    const max = decodeStatValue(stats.max_value, leaf);
    if (min === undefined || max === undefined) {
        return cannot('statistics could not be decoded');
    }
    return decide(min, max, op, v);
}

/** Evaluate one predicate against a dump (raw, un-annotated reasons). A bloom
 *  "miss" for a row group overrides its footer-statistics decision with a prune:
 *  the filter proves the value is absent even though it fell inside [min, max]. */
function evaluateOne(dump: AnyDump, p: Predicate, bloom?: BloomOutcome): Evaluation {
    const leaf = findSchemaLeaf(dump.metadata.schema_root, p.column);
    if (!leaf) {
        throw new Error(`unknown column '${p.column}'`);
    }

    const unsupported = unsupportedReason(leaf);
    const value = unsupported === null ? parsePredicateValue(p.value, leaf) : undefined;
    if (unsupported === null && value === undefined) {
        throw new Error(`'${p.value}' is not a valid ${leaf.type} value for column '${p.column}'`);
    }

    const rowGroups = new Map<number, Decision>();
    dump.metadata.row_groups.forEach((group, index) => {
        const meta = group.column_chunks[p.column]?.metadata;
        if (!meta) {
            return;
        }
        rowGroups.set(
            index,
            unsupported !== null
                ? cannot(`unsupported type: ${unsupported}`)
                : decideStats(meta.statistics, meta.num_values, leaf, p.op, value!)
        );
    });

    // A bloom "miss" is exact proof the value isn't in the row group — a prune
    // the footer min/max range couldn't make (the value fell inside [min, max]
    // but simply isn't present). Overrides that row group's stats decision.
    if (bloom) {
        for (const rg of bloom.misses) {
            if (rowGroups.has(rg)) {
                rowGroups.set(rg, {
                    pruned: true,
                    reason: `pruned — bloom filter proves ${fmt(p.value)} is absent from this row group`,
                });
            }
        }
    }

    const pages = new Map<string, Decision>();
    if ('column_chunks' in dump) {
        for (const chunk of dump.column_chunks) {
            if (chunk.path_in_schema !== p.column) {
                continue;
            }
            const ci = chunk.column_index;
            // Column-index entries correspond to the chunk's data pages in
            // order; the key is the projected page node's id (segment-tree
            // buildDataPage scheme).
            chunk.data_pages.forEach((_, i) => {
                const key = `rg_${chunk.row_group}_col_${chunk.path_in_schema}_data_${i}`;
                if (unsupported !== null) {
                    pages.set(key, cannot(`unsupported type: ${unsupported}`));
                } else if (!ci) {
                    pages.set(key, cannot('no column index written for this column chunk'));
                } else if (i >= ci.null_pages.length) {
                    pages.set(key, cannot('no column index entry for this page'));
                } else if (ci.null_pages[i]) {
                    pages.set(key, {
                        pruned: true,
                        reason: `pruned — page is entirely null; a ${OP_LABEL[p.op]} predicate never matches null`,
                    });
                } else {
                    const min = decodeStatValue(ci.min_values[i]!, leaf);
                    const max = decodeStatValue(ci.max_values[i]!, leaf);
                    pages.set(
                        key,
                        min === undefined || max === undefined
                            ? cannot('column index entry could not be decoded')
                            : decide(min, max, p.op, value!)
                    );
                }
            });
        }
    }

    return { rowGroups, pages };
}

type Part = { predicate: Predicate; decision: Decision };

/**
 * AND-compose per-predicate decisions for one segment: pruned when any
 * predicate prunes. Pruning reasons win the composed reason (kept reasons
 * don't dilute a prune); every reason names its predicate's column.
 */
function compose(parts: Part[]): Decision {
    const tag = (p: Part): string => `${p.decision.reason} (predicate on ${p.predicate.column})`;
    const pruning = parts.filter(p => p.decision.pruned);
    return pruning.length > 0
        ? { pruned: true, reason: pruning.map(tag).join('; ') }
        : { pruned: false, reason: parts.map(tag).join('; ') };
}

/** Union the per-predicate decision maps into `out`, composing per key. */
function mergeInto<K>(
    out: Map<K, Decision>,
    runs: { predicate: Predicate; decisions: Map<K, Decision> }[]
): void {
    const keys = new Set<K>();
    runs.forEach(r => r.decisions.forEach((_, k) => keys.add(k)));
    for (const key of keys) {
        const parts = runs.flatMap(r => {
            const decision = r.decisions.get(key);
            return decision ? [{ predicate: r.predicate, decision }] : [];
        });
        out.set(key, compose(parts));
    }
}

/**
 * Evaluate a conjunction of predicates against a dump.
 *
 * Throws on an unknown column or a value that doesn't parse for the column's
 * type (UI-level input errors). An unsupported column type is NOT an error:
 * every decision honestly reports "cannot prune". Zero predicates evaluate to
 * empty maps — nothing is pruned.
 *
 * Metadata-only dumps get row-group decisions only — the column index exists
 * in the footer, but its parsed contents (and the page nodes) aren't in the
 * export.
 *
 * `bloom` is optional per-predicate bloom-filter outcomes (see BloomResults):
 * a "miss" for a row group prunes it even when its min/max range couldn't. It's
 * gathered asynchronously by the UI (worker probes) and folded in on re-evaluate;
 * absent it, evaluation is exactly the synchronous statistics result.
 */
export function evaluate(dump: AnyDump, predicates: Predicate[], bloom?: BloomResults): Evaluation {
    const runs = predicates.map((predicate, i) => ({
        predicate,
        result: evaluateOne(dump, predicate, bloom?.get(i)),
    }));
    const rowGroups = new Map<number, Decision>();
    const pages = new Map<string, Decision>();
    mergeInto(
        rowGroups,
        runs.map(r => ({ predicate: r.predicate, decisions: r.result.rowGroups }))
    );
    mergeInto(
        pages,
        runs.map(r => ({ predicate: r.predicate, decisions: r.result.pages }))
    );
    return { rowGroups, pages };
}
