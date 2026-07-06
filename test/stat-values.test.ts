import { describe, it, expect } from 'vitest';
import {
    decodeStatValue,
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
        // Decimals: the raw int ignores the scale.
        expect(
            decodeStatValue(b64(1, 0, 0, 0), leaf('INT32', { converted_type: 'DECIMAL' }))
        ).toBeUndefined();
        // Unsigned ints: the sign bit breaks signed ordering.
        expect(
            decodeStatValue(b64(1, 0, 0, 0), leaf('INT32', { converted_type: 'UINT_32' }))
        ).toBeUndefined();
        expect(
            decodeStatValue(
                b64(1, 0, 0, 0),
                leaf('INT32', {
                    logical_type: { logical_type: 'INTEGER', bit_width: 32, is_signed: false },
                })
            )
        ).toBeUndefined();
        // Wrong byte length and corrupt base64.
        expect(decodeStatValue(b64(1, 0), leaf('INT32'))).toBeUndefined();
        expect(decodeStatValue('%%%not-base64%%%', leaf('INT32'))).toBeUndefined();
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

    it('names the problem for unsupported types', () => {
        expect(unsupportedReason(leaf('INT96'))).toContain('INT96');
        expect(unsupportedReason(leaf('BYTE_ARRAY'))).toContain('raw binary');
        expect(unsupportedReason(leaf('INT32', { converted_type: 'DECIMAL' }))).toContain(
            'DECIMAL'
        );
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
});
