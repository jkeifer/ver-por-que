/**
 * Minimal WKB (Well-Known Binary) decoder for value previews.
 *
 * Parquet GEOMETRY/GEOGRAPHY columns store ISO WKB in BYTE_ARRAY. This turns
 * those bytes into a short human summary — a point's coordinates, or a
 * geometry's type and total point count — never full WKT: a multipolygon's
 * coordinates would swamp the preview. Anything it can't parse (EWKB with an
 * SRID prefix, truncated bytes, unknown type codes) returns null, so the caller
 * falls back to showing the raw base64.
 */

/** WKB geometry type codes (base, before ISO Z/M dimension offsets). */
const NAMES: Record<number, string> = {
    1: 'POINT',
    2: 'LINESTRING',
    3: 'POLYGON',
    4: 'MULTIPOINT',
    5: 'MULTILINESTRING',
    6: 'MULTIPOLYGON',
    7: 'GEOMETRYCOLLECTION',
};

/** ISO dimension offset (typeCode / 1000) → label suffix. 1=Z, 2=M, 3=ZM. */
const DIM_SUFFIX: Record<number, string> = { 0: '', 1: ' Z', 2: ' M', 3: ' ZM' };

interface Reader {
    view: DataView;
    pos: number;
}

function readByteOrder(r: Reader): boolean {
    const b = r.view.getUint8(r.pos);
    r.pos += 1;
    if (b !== 0 && b !== 1) {
        throw new Error('bad byte order');
    }
    return b === 1; // 1 = little-endian (NDR); 0 = big-endian (XDR)
}

function read32(r: Reader, le: boolean): number {
    const v = r.view.getUint32(r.pos, le);
    r.pos += 4;
    return v;
}

/** Read `count` coordinates of `dim` doubles each; keep the first x,y seen. */
function readCoords(r: Reader, le: boolean, count: number, dim: number, firstXY: number[]): void {
    for (let i = 0; i < count; i++) {
        const x = r.view.getFloat64(r.pos, le);
        const y = r.view.getFloat64(r.pos + 8, le);
        if (firstXY.length === 0) {
            firstXY.push(x, y);
        }
        r.pos += 8 * dim; // x, y, then any z/m
    }
}

/** Read one geometry at the cursor, accumulating its total point count. */
function readGeom(r: Reader, firstXY: number[]): { code: number; kind: number; points: number } {
    const le = readByteOrder(r);
    const raw = read32(r, le);
    const code = raw % 1000; // strip ISO Z(1000)/M(2000)/ZM(3000) offset
    const kind = Math.floor(raw / 1000);
    if (!(code in NAMES) || !(kind in DIM_SUFFIX)) {
        throw new Error('unknown geometry type');
    }
    const dim = 2 + (kind === 1 || kind === 3 ? 1 : 0) + (kind === 2 || kind === 3 ? 1 : 0);
    let points = 0;
    switch (code) {
        case 1: // POINT
            points = 1;
            readCoords(r, le, 1, dim, firstXY);
            break;
        case 2: // LINESTRING
            points = read32(r, le);
            readCoords(r, le, points, dim, firstXY);
            break;
        case 3: {
            // POLYGON: numRings, then per ring numPoints + coords
            const rings = read32(r, le);
            for (let i = 0; i < rings; i++) {
                const n = read32(r, le);
                points += n;
                readCoords(r, le, n, dim, firstXY);
            }
            break;
        }
        default: {
            // MULTI* / GEOMETRYCOLLECTION: numGeoms, each a full sub-WKB.
            const n = read32(r, le);
            for (let i = 0; i < n; i++) {
                points += readGeom(r, firstXY).points;
            }
        }
    }
    return { code, kind, points };
}

/**
 * Summarize WKB bytes, e.g. `POINT(30 10)` or `MULTIPOLYGON · 512 points`, or
 * null when the bytes aren't parseable WKB (out-of-bounds reads and unknown
 * type codes both land here, so the caller shows the raw base64 instead).
 */
export function describeWkb(bytes: Uint8Array): string | null {
    try {
        const r: Reader = {
            view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            pos: 0,
        };
        const firstXY: number[] = [];
        const g = readGeom(r, firstXY);
        // readGeom already validated both codes exist; the ?? satisfies strict index access.
        const name = (NAMES[g.code] ?? '') + (DIM_SUFFIX[g.kind] ?? '');
        const [x, y] = firstXY;
        if (g.code === 1 && x !== undefined && y !== undefined) {
            return `${name}(${x} ${y})`;
        }
        return `${name} · ${g.points} point${g.points === 1 ? '' : 's'}`;
    } catch {
        return null;
    }
}
