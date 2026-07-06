import { describe, it, expect } from 'vitest';
import { getHashParam, setHashParam } from '../src/js/permalink';

describe('permalink hash (de)serialization', () => {
    it('reads a param from a hash, with or without the leading #', () => {
        expect(getHashParam('#node=rg_0', 'node')).toBe('rg_0');
        expect(getHashParam('node=rg_0', 'node')).toBe('rg_0');
        expect(getHashParam('', 'node')).toBeNull();
        expect(getHashParam('#', 'node')).toBeNull();
        expect(getHashParam('#lens=pages', 'node')).toBeNull();
    });

    it('round-trips node ids with dots and other URL-unsafe characters', () => {
        const id = 'rg_0_col_a.b c&d=e';
        expect(getHashParam(setHashParam('', 'node', id), 'node')).toBe(id);
    });

    it('sets, replaces, and removes a param, preserving other params', () => {
        const hash = setHashParam('#lens=pages', 'node', 'rg_1');
        expect(getHashParam(hash, 'node')).toBe('rg_1');
        expect(getHashParam(hash, 'lens')).toBe('pages');

        const replaced = setHashParam(hash, 'node', 'rg_2');
        expect(getHashParam(replaced, 'node')).toBe('rg_2');

        const removed = setHashParam(hash, 'node', null);
        expect(getHashParam(removed, 'node')).toBeNull();
        expect(getHashParam(removed, 'lens')).toBe('pages');
    });

    it('returns the empty string when nothing remains', () => {
        expect(setHashParam('#node=rg_0', 'node', null)).toBe('');
        expect(setHashParam('', 'node', null)).toBe('');
    });
});
