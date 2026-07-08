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
 * True when an INT32/INT64 leaf's raw bytes compare correctly as a plain
 * signed integer. DECIMAL (scale) and unsigned INTEGER (sign bit) do not.
 */
function isPlainSignedInt(leaf: SchemaLeaf): boolean {
    const lt = leaf.logical_type;
    if (lt?.logical_type === 'DECIMAL') {
        return false;
    }
    if (lt?.logical_type === 'INTEGER' && lt.is_signed === false) {
        return false;
    }
    if (leaf.converted_type === 'DECIMAL') {
        return false;
    }
    if (leaf.converted_type?.startsWith('UINT_')) {
        return false;
    }
    return true;
}

/**
 * Decode one base64 statistics value for a schema leaf.
 *
 * Supported exactly: INT32/INT64 (little-endian, signed), FLOAT/DOUBLE
 * (LE IEEE754), BOOLEAN, and BYTE_ARRAY/FIXED_LEN_BYTE_ARRAY with a
 * String/ENUM logical type (UTF-8). Everything else — INT96, decimals,
 * unsigned ints, UUIDs, raw binary — returns `undefined` = cannot evaluate.
 */
export function decodeStatValue(b64: string, leaf: SchemaLeaf): StatValue | undefined {
    const bytes = base64Bytes(b64);
    if (!bytes) {
        return undefined;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (leaf.type) {
        case 'INT32':
            return bytes.length === 4 && isPlainSignedInt(leaf)
                ? view.getInt32(0, true)
                : undefined;
        case 'INT64':
            return bytes.length === 8 && isPlainSignedInt(leaf)
                ? view.getBigInt64(0, true)
                : undefined;
        case 'FLOAT':
            return bytes.length === 4 ? view.getFloat32(0, true) : undefined;
        case 'DOUBLE':
            return bytes.length === 8 ? view.getFloat64(0, true) : undefined;
        case 'BOOLEAN':
            return bytes.length === 1 ? bytes[0] !== 0 : undefined;
        case 'BYTE_ARRAY':
        case 'FIXED_LEN_BYTE_ARRAY':
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
            return isPlainSignedInt(leaf)
                ? null
                : `${leaf.type} with ${leaf.logical_type?.logical_type ?? leaf.converted_type ?? 'a modified'} interpretation is not comparable as a plain signed integer`;
        case 'FLOAT':
        case 'DOUBLE':
        case 'BOOLEAN':
            return null;
        case 'BYTE_ARRAY':
        case 'FIXED_LEN_BYTE_ARRAY':
            return isStringLeaf(leaf)
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
    switch (leaf.type) {
        case 'INT32': {
            const n = Number(text);
            return text !== '' && Number.isInteger(n) ? n : undefined;
        }
        case 'INT64': {
            try {
                return text === '' ? undefined : BigInt(text);
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
