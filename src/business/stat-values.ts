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

function base64Bytes(b64: string): Uint8Array | undefined {
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
