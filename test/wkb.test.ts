import { describe, it, expect } from 'vitest';
import { describeWkb } from '../src/business/wkb';

/** Build a WKB byte string from a spec of tokens. */
function wkb(le: boolean, ...tokens: Array<['u8' | 'u32', number] | ['f64', number]>): Uint8Array {
    const size = tokens.reduce((n, [t]) => n + (t === 'u8' ? 1 : t === 'u32' ? 4 : 8), 0);
    const view = new DataView(new ArrayBuffer(size));
    let pos = 0;
    for (const [t, v] of tokens) {
        if (t === 'u8') {
            view.setUint8(pos, v);
            pos += 1;
        } else if (t === 'u32') {
            view.setUint32(pos, v, le);
            pos += 4;
        } else {
            view.setFloat64(pos, v, le);
            pos += 8;
        }
    }
    return new Uint8Array(view.buffer);
}

describe('describeWkb', () => {
    it('renders a little-endian POINT with its coordinates', () => {
        const bytes = wkb(true, ['u8', 1], ['u32', 1], ['f64', 30], ['f64', 10]);
        expect(describeWkb(bytes)).toBe('POINT(30 10)');
    });

    it('renders a big-endian POINT', () => {
        const bytes = wkb(false, ['u8', 0], ['u32', 1], ['f64', -122.5], ['f64', 45.5]);
        expect(describeWkb(bytes)).toBe('POINT(-122.5 45.5)');
    });

    it('counts points across a polygon ring', () => {
        // POLYGON, 1 ring, 4 points (a closed triangle).
        const bytes = wkb(
            true,
            ['u8', 1],
            ['u32', 3],
            ['u32', 1],
            ['u32', 4],
            ['f64', 0],
            ['f64', 0],
            ['f64', 1],
            ['f64', 0],
            ['f64', 0],
            ['f64', 1],
            ['f64', 0],
            ['f64', 0]
        );
        expect(describeWkb(bytes)).toBe('POLYGON · 4 points');
    });

    it('labels ISO Z dimensionality (POINT Z = type 1001)', () => {
        const bytes = wkb(true, ['u8', 1], ['u32', 1001], ['f64', 1], ['f64', 2], ['f64', 3]);
        expect(describeWkb(bytes)).toBe('POINT Z(1 2)');
    });

    it('returns null on truncated bytes', () => {
        // Header claims a POINT but the coordinates are missing.
        expect(describeWkb(wkb(true, ['u8', 1], ['u32', 1]))).toBeNull();
    });

    it('returns null on an unknown geometry type', () => {
        expect(describeWkb(wkb(true, ['u8', 1], ['u32', 99]))).toBeNull();
    });
});
