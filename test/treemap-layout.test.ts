import { describe, it, expect } from 'vitest';
import {
    squarify,
    type Rect,
    type SizedItem,
    type PlacedRect,
} from '../src/business/treemap-layout';

const container: Rect = { x: 0, y: 0, width: 100, height: 60 };

/** The classic Bruls et al. example set. */
const items: SizedItem[] = [6, 6, 4, 3, 2, 2, 1].map((size, i) => ({ id: `s${i}`, size }));

const area = (r: PlacedRect): number => r.width * r.height;

/** Worst (largest) aspect ratio across positive-area rects. */
function worstAspect(rects: PlacedRect[]): number {
    return Math.max(
        ...rects.filter(r => area(r) > 0).map(r => Math.max(r.width / r.height, r.height / r.width))
    );
}

describe('squarify', () => {
    it('returns [] for no items', () => {
        expect(squarify([], container)).toEqual([]);
    });

    it('every item comes back exactly once', () => {
        const rects = squarify(items, container);
        expect(rects.map(r => r.id).sort()).toEqual(items.map(i => i.id).sort());
    });

    it('areas sum to the container and are proportional to size', () => {
        const rects = squarify(items, container);
        const total = rects.reduce((s, r) => s + area(r), 0);
        expect(total).toBeCloseTo(container.width * container.height, 6);

        const sizeTotal = items.reduce((s, i) => s + i.size, 0);
        const scale = (container.width * container.height) / sizeTotal;
        for (const item of items) {
            const rect = rects.find(r => r.id === item.id)!;
            expect(area(rect)).toBeCloseTo(item.size * scale, 6);
        }
    });

    it('stays inside the container', () => {
        const offset: Rect = { x: 10, y: 20, width: 100, height: 60 };
        const rects = squarify(items, offset);
        for (const r of rects) {
            expect(r.x).toBeGreaterThanOrEqual(offset.x - 1e-9);
            expect(r.y).toBeGreaterThanOrEqual(offset.y - 1e-9);
            expect(r.x + r.width).toBeLessThanOrEqual(offset.x + offset.width + 1e-9);
            expect(r.y + r.height).toBeLessThanOrEqual(offset.y + offset.height + 1e-9);
        }
    });

    it('beats plain slicing on aspect ratio', () => {
        // Plain slicing: one vertical sliver per item across the full height.
        const sizeTotal = items.reduce((s, i) => s + i.size, 0);
        let x = 0;
        const sliced: PlacedRect[] = items.map(i => {
            const width = (i.size / sizeTotal) * container.width;
            const rect = { id: i.id, x, y: 0, width, height: container.height };
            x += width;
            return rect;
        });

        expect(worstAspect(squarify(items, container))).toBeLessThan(worstAspect(sliced));
    });

    it('zero-size items yield zero-area rects without breaking the rest', () => {
        const mixed: SizedItem[] = [
            { id: 'a', size: 10 },
            { id: 'zero', size: 0 },
            { id: 'b', size: 20 },
        ];
        const rects = squarify(mixed, container);
        expect(rects).toHaveLength(3);

        const zero = rects.find(r => r.id === 'zero')!;
        expect(area(zero)).toBe(0);

        const total = rects.reduce((s, r) => s + area(r), 0);
        expect(total).toBeCloseTo(container.width * container.height, 6);
        for (const r of rects) {
            expect(Number.isFinite(r.x)).toBe(true);
            expect(Number.isFinite(r.width)).toBe(true);
        }
    });

    it('all-zero items collapse to degenerate rects (no NaN)', () => {
        const zeros: SizedItem[] = [
            { id: 'a', size: 0 },
            { id: 'b', size: 0 },
        ];
        const rects = squarify(zeros, container);
        expect(rects).toHaveLength(2);
        for (const r of rects) {
            expect(area(r)).toBe(0);
            expect(Number.isNaN(r.x)).toBe(false);
        }
    });
});
