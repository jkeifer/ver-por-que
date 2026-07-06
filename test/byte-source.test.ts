import { describe, it, expect, vi, afterEach } from 'vitest';

import { fromBuffer, fromURL } from '../src/js/byte-source';

describe('fromBuffer', () => {
    const buffer = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer;

    it('knows its size and reads exact ranges', async () => {
        const source = fromBuffer(buffer);
        expect(source.size).toBe(10);
        expect(await source.read(2, 5)).toEqual(new Uint8Array([2, 3, 4]));
        expect(await source.read(0, 10)).toEqual(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
        expect(await source.read(4, 4)).toEqual(new Uint8Array(0));
    });

    it('rejects out-of-bounds reads', async () => {
        const source = fromBuffer(buffer);
        await expect(source.read(5, 11)).rejects.toThrow('out of bounds');
        await expect(source.read(-1, 2)).rejects.toThrow('out of bounds');
        await expect(source.read(6, 5)).rejects.toThrow('out of bounds');
    });
});

describe('fromURL', () => {
    // Big enough to span multiple 64 KB blocks; byte value derives from offset
    // so any misassembled read is detectable.
    const FILE = Uint8Array.from({ length: 200_000 }, (_, i) => i % 251);

    /** fetch stub honoring Range with 206 + Content-Range responses. */
    function stubRangeFetch(): ReturnType<typeof vi.fn> {
        const mock = vi.fn((_url: string, init?: RequestInit) => {
            const header = (init?.headers as Record<string, string>).Range ?? '';
            const range = /bytes=(\d+)-(\d+)/.exec(header)!;
            const start = Number(range[1]);
            const end = Math.min(Number(range[2]) + 1, FILE.length);
            return Promise.resolve(
                new Response(FILE.slice(start, end), {
                    status: 206,
                    headers: { 'Content-Range': `bytes ${start}-${end - 1}/${FILE.length}` },
                })
            );
        });
        vi.stubGlobal('fetch', mock);
        return mock;
    }

    afterEach(() => vi.unstubAllGlobals());

    it('reads a range within one block and learns the size', async () => {
        const mock = stubRangeFetch();
        const source = fromURL('https://example.com/f.parquet');

        expect(source.size).toBeNull();
        expect(await source.read(100, 300)).toEqual(FILE.slice(100, 300));
        expect(source.size).toBe(FILE.length);
        expect(mock).toHaveBeenCalledTimes(1);
    });

    it('assembles reads spanning block boundaries', async () => {
        const mock = stubRangeFetch();
        const source = fromURL('https://example.com/f.parquet');

        const boundary = 64 * 1024;
        expect(await source.read(boundary - 10, boundary + 10)).toEqual(
            FILE.slice(boundary - 10, boundary + 10)
        );
        expect(mock).toHaveBeenCalledTimes(2);
    });

    it('caches fetched blocks', async () => {
        const mock = stubRangeFetch();
        const source = fromURL('https://example.com/f.parquet');

        await source.read(0, 100);
        await source.read(500, 600);
        expect(mock).toHaveBeenCalledTimes(1);
    });

    it('gives up permanently when the server ignores Range', async () => {
        const mock = vi.fn(() => Promise.resolve(new Response(FILE, { status: 200 })));
        vi.stubGlobal('fetch', mock);
        const source = fromURL('https://example.com/f.parquet');

        await expect(source.read(0, 100)).rejects.toThrow('range requests');
        await expect(source.read(200, 300)).rejects.toThrow('range requests');
        expect(mock).toHaveBeenCalledTimes(1);
    });

    it('rejects on an error response', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve(new Response(null, { status: 404, statusText: 'Not Found' }))
            )
        );
        const source = fromURL('https://example.com/f.parquet');
        await expect(source.read(0, 100)).rejects.toThrow('HTTP 404');
    });
});
