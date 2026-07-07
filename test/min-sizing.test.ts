import { describe, it, expect } from 'vitest';
import { distributeWithMinimums, logarithmicMinimums } from '../src/business/min-sizing';

const opts = { baseline: 5, cap: 25, floor: 3, logFactor: 2 };

describe('logarithmicMinimums', () => {
    it('is monotonic in size', () => {
        const mins = logarithmicMinimums([10, 100, 1000, 10000], 1000, opts);
        for (let i = 1; i < mins.length; i++) {
            expect(mins[i]!).toBeGreaterThanOrEqual(mins[i - 1]!);
        }
    });

    it('falls back to an equal split when the budget is too tight', () => {
        // budget / n = 8/4 = 2 < floor(3) -> equal split
        const mins = logarithmicMinimums([1, 2, 3, 4], 8, opts);
        expect(mins).toEqual([2, 2, 2, 2]);
    });
});

describe('distributeWithMinimums', () => {
    it('extents sum to ~budget when everything fits', () => {
        const out = distributeWithMinimums([250, 250, 250, 250], 1000, 1000, opts);
        const sum = out.reduce((s, d) => s + d.extent, 0);
        expect(sum).toBeCloseTo(1000, 5);
    });

    it('expands a tiny item above its natural extent and steals from the big ones', () => {
        const out = distributeWithMinimums([1, 1000, 1000, 1000], 3001, 1000, opts);
        expect(out[0]!.isExpanded).toBe(true);
        expect(out[0]!.extent).toBeGreaterThan(out[0]!.natural);
        // big siblings shrink below their natural share to make room
        expect(out[1]!.extent).toBeLessThan(out[1]!.natural);
        const sum = out.reduce((s, d) => s + d.extent, 0);
        expect(sum).toBeCloseTo(1000, 5);
    });

    it('floors a zero-size item to its minimum, like the byte layout does', () => {
        const out = distributeWithMinimums([0, 500, 500], 1000, 1000, opts);
        expect(out[0]!.natural).toBe(0);
        expect(out[0]!.isExpanded).toBe(true);
        expect(out[0]!.extent).toBe(out[0]!.min);
    });

    it('gives every item zero extent when the total is zero', () => {
        const out = distributeWithMinimums([0, 0], 0, 1000, opts);
        expect(out.every(d => d.extent === 0)).toBe(true);
    });
});
