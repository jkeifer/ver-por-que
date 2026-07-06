import { describe, it, expect, vi, afterEach } from 'vitest';

import { fetchBytes } from '../src/js/fetch-progress';

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(chunk);
            }
            controller.close();
        },
    });
}

describe('fetchBytes', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('streams the body and reports fractional progress', async () => {
        const response = new Response(streamOf(new Uint8Array([1, 2]), new Uint8Array([3])), {
            headers: { 'Content-Length': '3' },
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

        const fractions: number[] = [];
        const bytes = await fetchBytes('https://example.com/f', f => fractions.push(f));

        expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
        expect(fractions).toEqual([2 / 3, 1]);
    });

    it('falls back to a buffered read without Content-Length', async () => {
        const response = new Response(streamOf(new Uint8Array([9])));
        response.headers.delete('Content-Length');
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

        const fractions: number[] = [];
        const bytes = await fetchBytes('https://example.com/f', f => fractions.push(f));

        expect(bytes).toEqual(new Uint8Array([9]));
        expect(fractions).toEqual([]);
    });

    it('throws on a non-ok response', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(new Response(null, { status: 404, statusText: 'Not Found' }))
        );
        await expect(fetchBytes('https://example.com/f')).rejects.toThrow('HTTP 404: Not Found');
    });
});
