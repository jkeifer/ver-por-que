/**
 * Statistics value decoding.
 *
 * Dump statistics (`min_value`/`max_value` in footer stats and column-index
 * page stats) are base64-encoded raw physical bytes. Decoding needs the leaf's
 * physical + logical type. `undefined` means "cannot evaluate" — the pruning
 * engine reports it honestly, it never guesses.
 */
import type { SchemaLeaf } from '../types';

/** A decoded, comparable statistics value. */
export type StatValue = number | bigint | boolean | string;

export function base64Bytes(b64: string): Uint8Array | undefined {
    // Dumps serialize stat bytes as base64, but some values arrive base64url
    // (`-`/`_` for `+`/`/`) — atob only accepts standard base64, so normalize
    // the URL-safe alphabet back before decoding. Without this, any stat whose
    // bytes encode a `-`/`_` sextet decodes to undefined ("cannot decode").
    const std = b64.replace(/-/g, '+').replace(/_/g, '/');
    try {
        const bin = atob(std);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
            out[i] = bin.charCodeAt(i);
        }
        return out;
    } catch {
        return undefined;
    }
}

/** BYTE_ARRAY / FIXED_LEN_BYTE_ARRAY bytes that are declared UTF-8 text. */
function isStringLeaf(leaf: SchemaLeaf): boolean {
    const lt = leaf.logical_type?.logical_type;
    if (lt === 'STRING' || lt === 'ENUM') {
        return true;
    }
    // Older writers only set the converted type; UTF8/ENUM are the same claim.
    return !lt && (leaf.converted_type === 'UTF8' || leaf.converted_type === 'ENUM');
}

/**
 * A "binary column": BYTE_ARRAY / FIXED_LEN_BYTE_ARRAY that is NOT a string leaf
 * (geometry WKB, UUID, raw binary). Its raw bytes aren't typeable, so base64 is
 * the canonical form — copied as the physical and base64-decoded before hashing
 * in a probe. The worker replicates this rule in Python (_is_binary_leaf).
 */
export function isBinaryLeaf(leaf: SchemaLeaf): boolean {
    return (
        (leaf.type === 'BYTE_ARRAY' || leaf.type === 'FIXED_LEN_BYTE_ARRAY') && !isStringLeaf(leaf)
    );
}

/** True when the leaf is a DECIMAL (any physical backing). */
function isDecimal(leaf: SchemaLeaf): boolean {
    return leaf.logical_type?.logical_type === 'DECIMAL' || leaf.converted_type === 'DECIMAL';
}

/** DECIMAL scale, from either the logical type or the leaf-level field. */
function decimalScale(leaf: SchemaLeaf): number {
    const lt = leaf.logical_type;
    if (lt?.logical_type === 'DECIMAL' && typeof lt.scale === 'number') {
        return lt.scale;
    }
    return leaf.scale ?? 0;
}

/** True when the leaf is an unsigned INTEGER (sign bit is a value bit). */
function isUnsignedInt(leaf: SchemaLeaf): boolean {
    const lt = leaf.logical_type;
    if (lt?.logical_type === 'INTEGER' && lt.is_signed === false) {
        return true;
    }
    return !!leaf.converted_type?.startsWith('UINT_');
}

/** Big-endian two's-complement integer over any-length bytes (DECIMAL FLBA/BYTE_ARRAY). */
function bigEndianTwosComplement(bytes: Uint8Array): bigint {
    if (bytes.length === 0) {
        return 0n;
    }
    let n = 0n;
    let negative = false;
    let first = true;
    for (const b of bytes) {
        if (first) {
            negative = (b & 0x80) !== 0;
            first = false;
        }
        n = (n << 8n) | BigInt(b);
    }
    // Sign-extend from the high bit of the first (most significant) byte.
    return negative ? n - (1n << BigInt(bytes.length * 8)) : n;
}

/**
 * Decode one base64 statistics value for a schema leaf.
 *
 * Supported exactly: INT32/INT64 (little-endian, signed or unsigned),
 * FLOAT/DOUBLE (LE IEEE754), BOOLEAN, DECIMAL (INT/FLBA/BYTE_ARRAY backing,
 * decoded to a scaled double), and BYTE_ARRAY/FIXED_LEN_BYTE_ARRAY with a
 * String/ENUM logical type (UTF-8). Everything else — INT96, UUIDs, raw
 * binary — returns `undefined` = cannot evaluate.
 */
export function decodeStatValue(b64: string, leaf: SchemaLeaf): StatValue | undefined {
    const bytes = base64Bytes(b64);
    if (!bytes) {
        return undefined;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (leaf.type) {
        case 'INT32':
            if (bytes.length !== 4) {
                return undefined;
            }
            if (isDecimal(leaf)) {
                // ponytail: number (double) result loses precision past ~2^53;
                // decode to exact bignum decimal if precision ever matters.
                return view.getInt32(0, true) / 10 ** decimalScale(leaf);
            }
            if (isUnsignedInt(leaf)) {
                return view.getUint32(0, true);
            }
            return view.getInt32(0, true);
        case 'INT64':
            if (bytes.length !== 8) {
                return undefined;
            }
            if (isDecimal(leaf)) {
                // ponytail: see INT32 DECIMAL note — double, not exact bignum.
                return Number(view.getBigInt64(0, true)) / 10 ** decimalScale(leaf);
            }
            if (isUnsignedInt(leaf)) {
                return view.getBigUint64(0, true);
            }
            return view.getBigInt64(0, true);
        case 'FLOAT':
            return bytes.length === 4 ? view.getFloat32(0, true) : undefined;
        case 'DOUBLE':
            return bytes.length === 8 ? view.getFloat64(0, true) : undefined;
        case 'BOOLEAN':
            return bytes.length === 1 ? bytes[0] !== 0 : undefined;
        case 'BYTE_ARRAY':
        case 'FIXED_LEN_BYTE_ARRAY':
            if (isDecimal(leaf)) {
                // Big-endian two's-complement unscaled int, any length (FLBA
                // width = type_length). ponytail: double result, see INT32 note.
                return Number(bigEndianTwosComplement(bytes)) / 10 ** decimalScale(leaf);
            }
            return isStringLeaf(leaf) ? new TextDecoder().decode(bytes) : undefined;
        default:
            // INT96 and anything future: no honest comparison exists.
            return undefined;
    }
}

/** Why a leaf's statistics can't be evaluated, or null when they can. */
export function unsupportedReason(leaf: SchemaLeaf): string | null {
    switch (leaf.type) {
        case 'INT32':
        case 'INT64':
            // DECIMAL and unsigned ints are now decoded; plain signed always was.
            return null;
        case 'FLOAT':
        case 'DOUBLE':
        case 'BOOLEAN':
            return null;
        case 'BYTE_ARRAY':
        case 'FIXED_LEN_BYTE_ARRAY':
            return isStringLeaf(leaf) || isDecimal(leaf)
                ? null
                : `${leaf.type} without a string logical type is raw binary`;
        default:
            return `physical type ${leaf.type} has no supported decoding`;
    }
}

const UNIT_PER_MS: Record<'MILLIS' | 'MICROS' | 'NANOS', number> = {
    MILLIS: 1,
    MICROS: 1_000,
    NANOS: 1_000_000,
};

/** Temporal kind + unit of a leaf (from logical or legacy converted type), else null. */
function temporalType(
    leaf: SchemaLeaf
): { kind: 'DATE' | 'TIME' | 'TIMESTAMP'; unit: 'MILLIS' | 'MICROS' | 'NANOS' } | null {
    const lt = leaf.logical_type;
    if (lt?.logical_type === 'DATE') {
        return { kind: 'DATE', unit: 'MILLIS' };
    }
    if (lt?.logical_type === 'TIME') {
        return { kind: 'TIME', unit: lt.unit ?? 'MILLIS' };
    }
    if (lt?.logical_type === 'TIMESTAMP') {
        return { kind: 'TIMESTAMP', unit: lt.unit ?? 'MILLIS' };
    }
    switch (leaf.converted_type) {
        case 'DATE':
            return { kind: 'DATE', unit: 'MILLIS' };
        case 'TIME_MILLIS':
            return { kind: 'TIME', unit: 'MILLIS' };
        case 'TIME_MICROS':
            return { kind: 'TIME', unit: 'MICROS' };
        case 'TIMESTAMP_MILLIS':
            return { kind: 'TIMESTAMP', unit: 'MILLIS' };
        case 'TIMESTAMP_MICROS':
            return { kind: 'TIMESTAMP', unit: 'MICROS' };
        default:
            return null;
    }
}

function isUtcAdjusted(leaf: SchemaLeaf): boolean {
    const lt = leaf.logical_type;
    return (
        (lt?.logical_type === 'TIMESTAMP' || lt?.logical_type === 'TIME') &&
        lt.is_adjusted_to_utc === true
    );
}

/** 16 raw bytes → canonical 8-4-4-4-12 hex UUID. */
function formatUuid(bytes: Uint8Array): string {
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Human display string for a statistics value: DATE/TIME/TIMESTAMP as ISO and
 * UUID as canonical hex, layered on top of the comparable value
 * `decodeStatValue` produces. Display ONLY — the pruning engine keeps using the
 * raw comparable value (an ISO string wouldn't compare correctly). `undefined`
 * means "nothing better than the raw bytes", so callers fall back to those.
 */
export function formatStatValue(b64: string, leaf: SchemaLeaf): string | undefined {
    if (leaf.logical_type?.logical_type === 'UUID' && leaf.type === 'FIXED_LEN_BYTE_ARRAY') {
        const bytes = base64Bytes(b64);
        return bytes?.length === 16 ? formatUuid(bytes) : undefined;
    }
    const decoded = decodeStatValue(b64, leaf);
    if (decoded === undefined) {
        return undefined;
    }
    const t = temporalType(leaf);
    if (t && (typeof decoded === 'number' || typeof decoded === 'bigint')) {
        // ponytail: Number() loses nanosecond precision far from epoch; this is
        // display only, so acceptable — the comparable value stays exact.
        const raw = Number(decoded);
        if (t.kind === 'DATE') {
            return new Date(raw * 86_400_000).toISOString().slice(0, 10);
        }
        const ms = raw / UNIT_PER_MS[t.unit];
        if (t.kind === 'TIME') {
            return new Date(ms)
                .toISOString()
                .slice(11, 23)
                .replace(/\.000$/, '');
        }
        const iso = new Date(ms).toISOString();
        return isUtcAdjusted(leaf) ? iso : iso.replace('Z', '');
    }
    return String(decoded);
}

/**
 * Parse user input as a comparable value for the column's type. Returns
 * `undefined` when the input doesn't parse for that type — a UI-level input
 * error, never an engine guess.
 */
export function parsePredicateValue(input: string, leaf: SchemaLeaf): StatValue | undefined {
    const text = input.trim();
    // DECIMAL decodes to a float, so predicates must parse the same way to
    // stay comparable, regardless of physical backing.
    if (isDecimal(leaf)) {
        const n = Number(text);
        return text !== '' && !Number.isNaN(n) ? n : undefined;
    }
    switch (leaf.type) {
        case 'INT32': {
            const n = Number(text);
            if (text === '' || !Number.isInteger(n)) {
                return undefined;
            }
            // Unsigned decodes as Number; reject negatives.
            return isUnsignedInt(leaf) && n < 0 ? undefined : n;
        }
        case 'INT64': {
            try {
                if (text === '') {
                    return undefined;
                }
                const n = BigInt(text);
                return isUnsignedInt(leaf) && n < 0n ? undefined : n;
            } catch {
                return undefined;
            }
        }
        case 'FLOAT':
        case 'DOUBLE': {
            const n = Number(text);
            return text !== '' && !Number.isNaN(n) ? n : undefined;
        }
        case 'BOOLEAN':
            return text === 'true' ? true : text === 'false' ? false : undefined;
        case 'BYTE_ARRAY':
        case 'FIXED_LEN_BYTE_ARRAY':
            // Strings compare as typed, untrimmed.
            return input;
        default:
            return undefined;
    }
}
