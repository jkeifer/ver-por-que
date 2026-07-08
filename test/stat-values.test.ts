import { describe, it, expect } from 'vitest';
import {
    decodeStatValue,
    formatStatValue,
    parsePredicateValue,
    unsupportedReason,
} from '../src/business/stat-values';
import type { SchemaLeaf } from '../src/types';

/** Minimal schema leaf for decode tests (only type info matters here). */
function leaf(type: SchemaLeaf['type'], extra: Partial<SchemaLeaf> = {}): SchemaLeaf {
    return {
        name: 'c',
        full_path: 'c',
        start_offset: 0,
        byte_length: 0,
        converted_type: null,
        repetition: 'OPTIONAL',
        type,
        ...extra,
    };
}

const b64 = (...bytes: number[]): string => Buffer.from(bytes).toString('base64');

describe('decodeStatValue', () => {
    it('decodes INT32 little-endian signed', () => {
        expect(decodeStatValue(b64(0x2a, 0, 0, 0), leaf('INT32'))).toBe(42);
        expect(decodeStatValue(b64(0xff, 0xff, 0xff, 0xff), leaf('INT32'))).toBe(-1);
    });

    it('decodes INT64 as BigInt', () => {
        expect(decodeStatValue(b64(0, 0, 0, 0, 0, 1, 0, 0), leaf('INT64'))).toBe(2n ** 40n);
        expect(
            decodeStatValue(b64(0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), leaf('INT64'))
        ).toBe(-2n);
    });

    it('decodes FLOAT and DOUBLE LE IEEE754', () => {
        expect(decodeStatValue(b64(0x00, 0x00, 0xc0, 0x3f), leaf('FLOAT'))).toBe(1.5);
        expect(decodeStatValue(b64(0, 0, 0, 0, 0, 0, 0x04, 0xc0), leaf('DOUBLE'))).toBe(-2.5);
    });

    it('accepts base64url stats (-/_) as well as standard base64', () => {
        // Real overture bbox.xmin DOUBLE stat, serialized base64url: `_` is `/`.
        // atob rejects the URL-safe alphabet, so these once decoded to undefined.
        expect(decodeStatValue('AAAA4C_kZcA=', leaf('DOUBLE'))).toBeCloseTo(-175.1308441, 5);
        expect(decodeStatValue('AAAAQNh-VsA=', leaf('DOUBLE'))).toBeCloseTo(-89.9819488, 5);
    });

    it('decodes BOOLEAN', () => {
        expect(decodeStatValue(b64(1), leaf('BOOLEAN'))).toBe(true);
        expect(decodeStatValue(b64(0), leaf('BOOLEAN'))).toBe(false);
    });

    it('decodes BYTE_ARRAY with a STRING logical type as UTF-8', () => {
        const l = leaf('BYTE_ARRAY', { logical_type: { logical_type: 'STRING' } });
        expect(decodeStatValue('SGVsbG8=', l)).toBe('Hello');
        expect(decodeStatValue('dG9kYXk=', l)).toBe('today');
    });

    it('decodes FIXED_LEN_BYTE_ARRAY with ENUM / UTF8 converted type', () => {
        expect(
            decodeStatValue('SGVsbG8=', leaf('FIXED_LEN_BYTE_ARRAY', { converted_type: 'ENUM' }))
        ).toBe('Hello');
        expect(decodeStatValue('SGVsbG8=', leaf('BYTE_ARRAY', { converted_type: 'UTF8' }))).toBe(
            'Hello'
        );
    });

    it('returns undefined for everything it cannot honestly compare', () => {
        // Raw binary: no declared string interpretation.
        expect(decodeStatValue('SGVsbG8=', leaf('BYTE_ARRAY'))).toBeUndefined();
        // INT96: unsupported physical type.
        expect(decodeStatValue(b64(...Array<number>(12).fill(0)), leaf('INT96'))).toBeUndefined();
        // Wrong byte length and corrupt base64.
        expect(decodeStatValue(b64(1, 0), leaf('INT32'))).toBeUndefined();
        expect(decodeStatValue('%%%not-base64%%%', leaf('INT32'))).toBeUndefined();
    });

    it('decodes DECIMAL INT32-backed, scaled', () => {
        // unscaled 12345, scale 2 -> 123.45
        const l = leaf('INT32', { converted_type: 'DECIMAL', scale: 2 });
        expect(decodeStatValue(b64(0x39, 0x30, 0, 0), l)).toBeCloseTo(123.45, 10);
        // scale from the logical type object instead of the leaf field.
        const lt = leaf('INT32', {
            logical_type: { logical_type: 'DECIMAL', precision: 9, scale: 2 },
        });
        expect(decodeStatValue(b64(0x39, 0x30, 0, 0), lt)).toBeCloseTo(123.45, 10);
    });

    it('decodes DECIMAL INT64-backed, scaled', () => {
        // unscaled 1000000, scale 3 -> 1000.0
        const l = leaf('INT64', { converted_type: 'DECIMAL', scale: 3 });
        expect(decodeStatValue(b64(0x40, 0x42, 0x0f, 0, 0, 0, 0, 0), l)).toBeCloseTo(1000, 10);
    });

    it('decodes DECIMAL FIXED_LEN_BYTE_ARRAY big-endian two-s-complement', () => {
        const l = leaf('FIXED_LEN_BYTE_ARRAY', { converted_type: 'DECIMAL', scale: 2 });
        // 0x0000...12345 big-endian, scale 2 -> 745.65 (0x012345 = 74565)
        expect(decodeStatValue(b64(0x01, 0x23, 0x45), l)).toBeCloseTo(745.65, 10);
        // Negative: 0xFFFFFF = -1 (two's-complement, 3 bytes), scale 2 -> -0.01
        expect(decodeStatValue(b64(0xff, 0xff, 0xff), l)).toBeCloseTo(-0.01, 10);
        // 0xFF38 = -200 over 2 bytes, scale 2 -> -2.0
        expect(decodeStatValue(b64(0xff, 0x38), l)).toBeCloseTo(-2, 10);
    });

    it('decodes DECIMAL BYTE_ARRAY big-endian', () => {
        const l = leaf('BYTE_ARRAY', {
            logical_type: { logical_type: 'DECIMAL', precision: 10, scale: 4 },
        });
        // 0x0F4240 = 1000000, scale 4 -> 100.0
        expect(decodeStatValue(b64(0x0f, 0x42, 0x40), l)).toBeCloseTo(100, 10);
    });

    it('decodes unsigned INT32 above 2^31 as a positive number', () => {
        // 0xFFFFFFFF -> 4294967295 (would be -1 if signed).
        const conv = leaf('INT32', { converted_type: 'UINT_32' });
        expect(decodeStatValue(b64(0xff, 0xff, 0xff, 0xff), conv)).toBe(4294967295);
        const log = leaf('INT32', {
            logical_type: { logical_type: 'INTEGER', bit_width: 32, is_signed: false },
        });
        expect(decodeStatValue(b64(0xff, 0xff, 0xff, 0xff), log)).toBe(4294967295);
    });

    it('decodes unsigned INT64 large value as a positive bigint', () => {
        // 0xFFFFFFFFFFFFFFFF -> 2^64 - 1 (would be -1 if signed).
        const l = leaf('INT64', { converted_type: 'UINT_64' });
        expect(decodeStatValue(b64(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), l)).toBe(
            2n ** 64n - 1n
        );
    });
});

describe('unsupportedReason', () => {
    it('is null for supported types', () => {
        for (const t of ['INT32', 'INT64', 'FLOAT', 'DOUBLE', 'BOOLEAN'] as const) {
            expect(unsupportedReason(leaf(t))).toBeNull();
        }
        expect(
            unsupportedReason(leaf('BYTE_ARRAY', { logical_type: { logical_type: 'STRING' } }))
        ).toBeNull();
    });

    it('is null for DECIMAL and unsigned integer leaves', () => {
        expect(unsupportedReason(leaf('INT32', { converted_type: 'DECIMAL' }))).toBeNull();
        expect(
            unsupportedReason(leaf('FIXED_LEN_BYTE_ARRAY', { converted_type: 'DECIMAL' }))
        ).toBeNull();
        expect(unsupportedReason(leaf('INT32', { converted_type: 'UINT_32' }))).toBeNull();
        expect(
            unsupportedReason(
                leaf('INT64', {
                    logical_type: { logical_type: 'INTEGER', bit_width: 64, is_signed: false },
                })
            )
        ).toBeNull();
    });

    it('names the problem for unsupported types', () => {
        expect(unsupportedReason(leaf('INT96'))).toContain('INT96');
        expect(unsupportedReason(leaf('BYTE_ARRAY'))).toContain('raw binary');
    });
});

describe('parsePredicateValue', () => {
    it('parses per physical type', () => {
        expect(parsePredicateValue('42', leaf('INT32'))).toBe(42);
        expect(parsePredicateValue('-7', leaf('INT32'))).toBe(-7);
        expect(parsePredicateValue('123', leaf('INT64'))).toBe(123n);
        expect(parsePredicateValue('1.5', leaf('DOUBLE'))).toBe(1.5);
        expect(parsePredicateValue('1.5', leaf('FLOAT'))).toBe(1.5);
        expect(parsePredicateValue('true', leaf('BOOLEAN'))).toBe(true);
        expect(parsePredicateValue('false', leaf('BOOLEAN'))).toBe(false);
        const s = leaf('BYTE_ARRAY', { logical_type: { logical_type: 'STRING' } });
        expect(parsePredicateValue('Hello', s)).toBe('Hello');
    });

    it('rejects input that does not parse for the type', () => {
        expect(parsePredicateValue('4.5', leaf('INT32'))).toBeUndefined();
        expect(parsePredicateValue('abc', leaf('INT32'))).toBeUndefined();
        expect(parsePredicateValue('abc', leaf('INT64'))).toBeUndefined();
        expect(parsePredicateValue('abc', leaf('DOUBLE'))).toBeUndefined();
        expect(parsePredicateValue('', leaf('DOUBLE'))).toBeUndefined();
        expect(parsePredicateValue('yes', leaf('BOOLEAN'))).toBeUndefined();
    });

    it('parses DECIMAL predicates to the same scaled-double representation', () => {
        // Predicate 123.45 must equal the decoded INT32 DECIMAL stat above.
        const l = leaf('INT32', { converted_type: 'DECIMAL', scale: 2 });
        expect(parsePredicateValue('123.45', l)).toBe(123.45);
        expect(decodeStatValue(b64(0x39, 0x30, 0, 0), l)).toBe(parsePredicateValue('123.45', l));
        expect(parsePredicateValue('', l)).toBeUndefined();
    });

    it('parses unsigned predicates and rejects negatives', () => {
        const u32 = leaf('INT32', { converted_type: 'UINT_32' });
        expect(parsePredicateValue('4294967295', u32)).toBe(4294967295);
        expect(parsePredicateValue('-1', u32)).toBeUndefined();
        const u64 = leaf('INT64', { converted_type: 'UINT_64' });
        expect(parsePredicateValue('18446744073709551615', u64)).toBe(2n ** 64n - 1n);
        expect(parsePredicateValue('-1', u64)).toBeUndefined();
    });
});

const le32 = (n: number): string => {
    const v = new DataView(new ArrayBuffer(4));
    v.setInt32(0, n, true);
    return Buffer.from(new Uint8Array(v.buffer)).toString('base64');
};
const le64 = (n: bigint): string => {
    const v = new DataView(new ArrayBuffer(8));
    v.setBigInt64(0, n, true);
    return Buffer.from(new Uint8Array(v.buffer)).toString('base64');
};

describe('formatStatValue', () => {
    it('formats DATE (INT32 days since epoch) as ISO date', () => {
        const l = leaf('INT32', { logical_type: { logical_type: 'DATE' } });
        expect(formatStatValue(le32(19723), l)).toBe('2024-01-01');
    });

    it('formats TIME_MILLIS as time of day', () => {
        const l = leaf('INT32', { logical_type: { logical_type: 'TIME', unit: 'MILLIS' } });
        expect(formatStatValue(le32(3_661_000), l)).toBe('01:01:01');
    });

    it('formats a UTC TIMESTAMP_MICROS as ISO instant with Z', () => {
        const l = leaf('INT64', {
            logical_type: { logical_type: 'TIMESTAMP', unit: 'MICROS', is_adjusted_to_utc: true },
        });
        expect(formatStatValue(le64(1_704_067_200_000_000n), l)).toBe('2024-01-01T00:00:00.000Z');
    });

    it('drops the Z for a local (non-UTC) timestamp', () => {
        const l = leaf('INT64', {
            logical_type: { logical_type: 'TIMESTAMP', unit: 'MICROS', is_adjusted_to_utc: false },
        });
        expect(formatStatValue(le64(1_704_067_200_000_000n), l)).toBe('2024-01-01T00:00:00.000');
    });

    it('formats a UUID FIXED_LEN_BYTE_ARRAY as canonical hex', () => {
        const l = leaf('FIXED_LEN_BYTE_ARRAY', { logical_type: { logical_type: 'UUID' } });
        const bytes = b64(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15);
        expect(formatStatValue(bytes, l)).toBe('00010203-0405-0607-0809-0a0b0c0d0e0f');
    });

    it('falls back to the plain decoded value for non-temporal types', () => {
        expect(formatStatValue(b64(0x2a, 0, 0, 0), leaf('INT32'))).toBe('42');
    });
});
