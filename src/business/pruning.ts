/**
 * Predicate-pushdown pruning engine (pure, no DOM).
 *
 * Simulates what a reader would skip for one predicate: row groups via footer
 * column statistics, pages via the column index. Every decision carries a
 * stated reason. Unsupported types and missing statistics report "cannot
 * prune" — the engine never guesses. Page decisions are keyed by the
 * segment-tree node id of the page node so the UI can dim rects directly.
 */
import { findSchemaLeaf } from './segment-tree';
import {
    decodeStatValue,
    parsePredicateValue,
    unsupportedReason,
    type StatValue,
} from './stat-values';
import type { AnyDump, ColumnStatistics, SchemaLeaf, SchemaGroup, SchemaRoot } from '../types';

export type Op = 'eq' | 'lt' | 'lte' | 'gt' | 'gte';

export const OP_LABEL: Record<Op, string> = { eq: '=', lt: '<', lte: '≤', gt: '>', gte: '≥' };

export function isOp(v: unknown): v is Op {
    return typeof v === 'string' && v in OP_LABEL;
}

export interface Predicate {
    column: string;
    op: Op;
    value: string;
}

export type Decision = { pruned: boolean; reason: string };

export interface Evaluation {
    /** Footer-statistics decision per row group index. */
    rowGroups: Map<number, Decision>;
    /** Column-index decision per page, keyed by segment-tree node id. */
    pages: Map<string, Decision>;
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
function fmt(v: StatValue): string {
    return typeof v === 'string' ? `'${v}'` : String(v);
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

/**
 * Evaluate one predicate against a dump.
 *
 * Throws on an unknown column or a value that doesn't parse for the column's
 * type (UI-level input errors). An unsupported column type is NOT an error:
 * every decision honestly reports "cannot prune".
 *
 * Metadata-only dumps get row-group decisions only — the column index exists
 * in the footer, but its parsed contents (and the page nodes) aren't in the
 * export.
 */
export function evaluate(dump: AnyDump, p: Predicate): Evaluation {
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
