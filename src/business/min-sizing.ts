/**
 * Minimum-sizing for proportional layouts (shared by the byte-layout and
 * treemap lenses).
 *
 * Pure math, unit-agnostic. Given item sizes and a budget (container width for
 * the 1-D byte layout, container area for the 2-D treemap), it floors tiny
 * items to a log-scaled minimum extent and proportionally shrinks the big items
 * to keep the total within budget — so metadata never collapses to nothing next
 * to a huge data segment. Callers supply the baseline/cap/floor magnitudes in
 * their own target unit.
 */

export interface MinSizingOpts {
    /** Starting minimum extent for the smallest item. */
    baseline: number;
    /** Largest minimum extent, reached by the biggest item (log-scaled up to it). */
    cap: number;
    /** Below this per-item share, minimums are pointless: fall back to an equal split. */
    floor: number;
    /** Log-curve shaping exponent; higher pushes minimums toward the baseline. */
    logFactor: number;
}

export interface DistributedExtent {
    /** Final extent in budget units, floored to the minimum where the item is tiny. */
    extent: number;
    /** True when the item was expanded up to its minimum. */
    isExpanded: boolean;
    /** Natural (purely proportional) extent before any flooring. */
    natural: number;
    /** The item's minimum extent. */
    min: number;
}

/** Log-scaled minimum extent per item, in the same unit as `budget`. */
export function logarithmicMinimums(
    sizes: number[],
    budget: number,
    opts: MinSizingOpts
): number[] {
    if (sizes.length === 0) {
        return [];
    }

    const adjustedBaseline = Math.min(opts.baseline, budget / sizes.length);
    if (adjustedBaseline < opts.floor) {
        return sizes.map(() => budget / sizes.length);
    }

    const clamped = sizes.map(s => Math.max(1, s));
    const minSize = Math.min(...clamped);
    const maxSize = Math.max(...clamped);

    if (minSize === maxSize) {
        return sizes.map(() => adjustedBaseline);
    }

    const logMinSize = Math.log10(minSize);
    const logRange = Math.log10(maxSize) - logMinSize;

    const mins = clamped.map(size => {
        const logPosition = (Math.log10(size) - logMinSize) / logRange;
        const scaledPosition = Math.pow(logPosition, 1 / opts.logFactor);
        return adjustedBaseline + (opts.cap - adjustedBaseline) * scaledPosition;
    });

    const total = mins.reduce((sum, m) => sum + m, 0);
    if (total > budget) {
        const scale = budget / total;
        return mins.map(m => m * scale);
    }
    return mins;
}

/**
 * Distribute `budget` across items: natural extent = (size / total) * budget,
 * with tiny items floored to their log-scaled minimum and the rest rescaled to
 * fit. `total` is the denominator for the natural share (byte-span for the byte
 * layout so gaps are honoured; Σsize for the treemap so extents sum to budget).
 */
export function distributeWithMinimums(
    sizes: number[],
    total: number,
    budget: number,
    opts: MinSizingOpts
): DistributedExtent[] {
    if (sizes.length === 0) {
        return [];
    }
    if (total <= 0 || budget <= 0) {
        return sizes.map(() => ({ extent: 0, isExpanded: false, natural: 0, min: 0 }));
    }

    const mins = logarithmicMinimums(sizes, budget, opts);
    const items: DistributedExtent[] = sizes.map((size, i) => {
        const natural = (Math.max(0, size) / total) * budget;
        const min = mins[i] ?? 0;
        const isExpanded = natural < min;
        return { extent: isExpanded ? min : natural, isExpanded, natural, min };
    });

    const extraSpaceUsed = items.reduce(
        (sum, item) => sum + (item.isExpanded ? item.extent - item.natural : 0),
        0
    );
    if (extraSpaceUsed > 0) {
        const usedByExpanded = items.reduce(
            (sum, item) => sum + (item.isExpanded ? item.extent : 0),
            0
        );
        const availableSpace = budget - usedByExpanded;
        const naturalForNonExpanded = items.reduce(
            (sum, item) => sum + (item.isExpanded ? 0 : item.natural),
            0
        );
        if (naturalForNonExpanded > 0) {
            const scale = availableSpace / naturalForNonExpanded;
            for (const item of items) {
                if (!item.isExpanded) {
                    item.extent = item.natural * scale;
                }
            }
        }
    }

    return items;
}
