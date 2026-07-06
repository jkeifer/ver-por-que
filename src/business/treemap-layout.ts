/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk).
 *
 * Pure math, DOM-free: turns {id, size} items + a container rect into placed
 * rects whose areas are proportional to size. Rows are sliced greedily off the
 * shorter side of the remaining free rect, adding items while the row's worst
 * aspect ratio keeps improving. Zero-size items yield degenerate (zero-area)
 * rects at the container origin rather than breaking the row math.
 */

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface SizedItem {
    id: string;
    size: number;
}

export type PlacedRect = Rect & { id: string };

/** Worst (largest) aspect ratio a row of areas would have along a strip of length `side`. */
function worstAspect(areas: number[], side: number): number {
    const sum = areas.reduce((s, a) => s + a, 0);
    if (sum <= 0 || side <= 0) {
        return Infinity;
    }
    let worst = 0;
    for (const area of areas) {
        const ratio = Math.max(
            (side * side * area) / (sum * sum),
            (sum * sum) / (side * side * area)
        );
        worst = Math.max(worst, ratio);
    }
    return worst;
}

/** Slice a finished row off the shorter side of `free`, mutating `free`. */
function layoutRow(row: SizedItem[], areas: number[], free: Rect, out: PlacedRect[]): void {
    const sum = areas.reduce((s, a) => s + a, 0);
    if (free.width >= free.height) {
        // Row runs down the left edge; strip width = row area / strip length.
        const stripWidth = sum / free.height;
        let y = free.y;
        row.forEach((item, i) => {
            const height = areas[i]! / stripWidth;
            out.push({ id: item.id, x: free.x, y, width: stripWidth, height });
            y += height;
        });
        free.x += stripWidth;
        free.width -= stripWidth;
    } else {
        // Row runs across the top edge.
        const stripHeight = sum / free.width;
        let x = free.x;
        row.forEach((item, i) => {
            const width = areas[i]! / stripHeight;
            out.push({ id: item.id, x, y: free.y, width, height: stripHeight });
            x += width;
        });
        free.y += stripHeight;
        free.height -= stripHeight;
    }
}

/**
 * Place every item in the container, area ∝ size. Every input id comes back
 * exactly once; zero/negative sizes come back as zero-area rects.
 */
export function squarify(items: SizedItem[], container: Rect): PlacedRect[] {
    const out: PlacedRect[] = [];
    const positive: SizedItem[] = [];
    for (const item of items) {
        if (item.size > 0) {
            positive.push(item);
        } else {
            out.push({ id: item.id, x: container.x, y: container.y, width: 0, height: 0 });
        }
    }

    const total = positive.reduce((s, i) => s + i.size, 0);
    if (total <= 0 || container.width <= 0 || container.height <= 0) {
        for (const item of positive) {
            out.push({ id: item.id, x: container.x, y: container.y, width: 0, height: 0 });
        }
        return out;
    }

    const scale = (container.width * container.height) / total;
    const sorted = [...positive].sort((a, b) => b.size - a.size);

    const free: Rect = { ...container };
    let row: SizedItem[] = [];
    let rowAreas: number[] = [];

    for (const item of sorted) {
        const area = item.size * scale;
        const side = Math.min(free.width, free.height);
        if (
            row.length === 0 ||
            worstAspect([...rowAreas, area], side) <= worstAspect(rowAreas, side)
        ) {
            row.push(item);
            rowAreas.push(area);
        } else {
            layoutRow(row, rowAreas, free, out);
            row = [item];
            rowAreas = [item.size * scale];
        }
    }
    if (row.length > 0) {
        layoutRow(row, rowAreas, free, out);
    }

    return out;
}
