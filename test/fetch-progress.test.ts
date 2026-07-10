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
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

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

    it('throws on a non-ok response, without retrying a client error', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(new Response(null, { status: 404, statusText: 'Not Found' }));
        vi.stubGlobal('fetch', fetchMock);
        await expect(fetchBytes('https://example.com/f')).rejects.toThrow('HTTP 404: Not Found');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries transient failures (network error, 5xx) before succeeding', async () => {
        // Safari masks CORS-less error responses as generic fetch failures
        // (TypeError: Load failed); a 500 can also arrive undisguised. Both
        // are transient when the connection was poisoned by concurrent range
        // reads, so both retry.
        vi.useFakeTimers();
        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new TypeError('Load failed'))
            .mockResolvedValueOnce(new Response(null, { status: 500, statusText: 'Server Error' }))
            .mockResolvedValueOnce(
                new Response(streamOf(new Uint8Array([7])), {
                    headers: { 'Content-Length': '1' },
                })
            );
        vi.stubGlobal('fetch', fetchMock);

        const promise = fetchBytes('https://example.com/f');
        await vi.runAllTimersAsync();
        expect(await promise).toEqual(new Uint8Array([7]));
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('gives up after exhausting the retry budget', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn().mockRejectedValue(new TypeError('Load failed'));
        vi.stubGlobal('fetch', fetchMock);

        const promise = fetchBytes('https://example.com/f');
        // Attach the rejection expectation before draining timers so the
        // rejection is never unhandled.
        const expectation = expect(promise).rejects.toThrow('Load failed');
        await vi.runAllTimersAsync();
        await expectation;
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });
});
