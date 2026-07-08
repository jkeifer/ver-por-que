/**
 * Minimal WKB (Well-Known Binary) decoder for value previews.
 *
 * Parquet GEOMETRY/GEOGRAPHY columns store ISO WKB in BYTE_ARRAY. This turns
 * those bytes into a short human summary — a point's coordinates, or a
 * geometry's type and total point count — never full WKT: a multipolygon's
 * coordinates would swamp the preview. Anything it can't parse (truncated
 * bytes, unknown/curve type codes) returns null, so the caller falls back to
 * showing the raw base64.
 *
 * ISO WKB is the Parquet-spec encoding; PostGIS EWKB (Z/M/SRID flagged in the
 * type's high bits, with an inline SRID) is also read leniently for data that
 * came from non-conformant writers — the SRID is skipped (CRS lives in Parquet
 * metadata, and GeoJSON is WGS84 by definition).
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

// EWKB flags the high bits of the type word (vs ISO WKB's +1000/2000/3000).
const EWKB_Z = 0x80000000;
const EWKB_M = 0x40000000;
const EWKB_SRID = 0x20000000;

/**
 * Read a geometry header: byte order, then the type word decoded to a base
 * type code and dimensionality, transparently handling both ISO WKB and EWKB.
 * An EWKB inline SRID is consumed and discarded. Throws on unknown type codes
 * (including curves, which GeoJSON can't represent).
 */
function readHeader(r: Reader): { le: boolean; code: number; hasZ: boolean; hasM: boolean } {
    const le = readByteOrder(r);
    const raw = read32(r, le);
    let code: number;
    let hasZ: boolean;
    let hasM: boolean;
    if (raw & (EWKB_Z | EWKB_M | EWKB_SRID)) {
        code = raw & 0x0fffffff; // strip Z/M/SRID/bbox flag bits
        hasZ = (raw & EWKB_Z) !== 0;
        hasM = (raw & EWKB_M) !== 0;
        if (raw & EWKB_SRID) {
            read32(r, le); // skip the 4-byte SRID
        }
    } else {
        code = raw % 1000; // ISO Z(1000)/M(2000)/ZM(3000) offset
        const kind = Math.floor(raw / 1000);
        hasZ = kind === 1 || kind === 3;
        hasM = kind === 2 || kind === 3;
    }
    if (!(code in NAMES)) {
        throw new Error('unknown geometry type');
    }
    return { le, code, hasZ, hasM };
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
    const { le, code, hasZ, hasM } = readHeader(r);
    const kind = (hasZ ? 1 : 0) + (hasM ? 2 : 0); // index into DIM_SUFFIX
    const dim = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
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

type Position = number[];
export interface GeoJsonGeometry {
    type:
        | 'Point'
        | 'LineString'
        | 'Polygon'
        | 'MultiPoint'
        | 'MultiLineString'
        | 'MultiPolygon'
        | 'GeometryCollection';
    coordinates?: unknown;
    geometries?: GeoJsonGeometry[];
}

/**
 * Read one geometry at the cursor into a GeoJSON geometry object, collecting
 * every coordinate (unlike readGeom, which only counts them). Z is kept as a
 * third ordinate; an M measure is consumed but dropped (GeoJSON has no M).
 */
function readGeometry(r: Reader): GeoJsonGeometry {
    const { le, code, hasZ, hasM } = readHeader(r);
    const coord = (): Position => {
        const p: Position = [r.view.getFloat64(r.pos, le), r.view.getFloat64(r.pos + 8, le)];
        r.pos += 16;
        if (hasZ) {
            p.push(r.view.getFloat64(r.pos, le));
            r.pos += 8;
        }
        if (hasM) {
            r.pos += 8; // consume the measure; GeoJSON can't represent it
        }
        return p;
    };
    const ring = (): Position[] => {
        const n = read32(r, le);
        const out: Position[] = [];
        for (let i = 0; i < n; i++) {
            out.push(coord());
        }
        return out;
    };
    // sub-geometries in a MULTI* carry their own header, so recurse.
    const children = (): GeoJsonGeometry[] => {
        const n = read32(r, le);
        const out: GeoJsonGeometry[] = [];
        for (let i = 0; i < n; i++) {
            out.push(readGeometry(r));
        }
        return out;
    };
    switch (code) {
        case 1:
            return { type: 'Point', coordinates: coord() };
        case 2:
            return { type: 'LineString', coordinates: ring() };
        case 3: {
            const rings: Position[][] = [];
            const n = read32(r, le);
            for (let i = 0; i < n; i++) {
                rings.push(ring());
            }
            return { type: 'Polygon', coordinates: rings };
        }
        case 4:
            return { type: 'MultiPoint', coordinates: children().map(g => g.coordinates) };
        case 5:
            return { type: 'MultiLineString', coordinates: children().map(g => g.coordinates) };
        case 6:
            return { type: 'MultiPolygon', coordinates: children().map(g => g.coordinates) };
        default:
            return { type: 'GeometryCollection', geometries: children() };
    }
}

/**
 * Parse WKB bytes into a full GeoJSON geometry (all coordinates), or null when
 * the bytes aren't parseable WKB. Used to copy the real geometry, not the
 * summary describeWkb shows.
 */
export function wkbToGeoJson(bytes: Uint8Array): GeoJsonGeometry | null {
    try {
        return readGeometry({
            view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            pos: 0,
        });
    } catch {
        return null;
    }
}
