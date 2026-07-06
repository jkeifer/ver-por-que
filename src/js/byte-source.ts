/**
 * Byte access to the loaded file's raw bytes, for the hex inspector. Local
 * loads read from the retained ArrayBuffer; remote loads read via HTTP Range
 * requests with a small block cache. JSON-dump loads (no original file) have
 * no byte source and the UI degrades.
 */

export interface ByteSource {
    /** Total length if known. */
    size: number | null;
    /** Read [start, end); rejects if unavailable. */
    read(start: number, end: number): Promise<Uint8Array>;
}

/** Byte source over an in-memory buffer (local file loads). */
export function fromBuffer(buffer: ArrayBuffer): ByteSource {
    return {
        size: buffer.byteLength,
        read(start: number, end: number): Promise<Uint8Array> {
            if (start < 0 || end < start || end > buffer.byteLength) {
                return Promise.reject(
                    new Error(`range [${start}, ${end}) out of bounds (size ${buffer.byteLength})`)
                );
            }
            return Promise.resolve(new Uint8Array(buffer, start, end - start));
        },
    };
}

const BLOCK_SIZE = 64 * 1024;

/**
 * Byte source over a remote URL via HTTP Range requests. Fetches are cached
 * as aligned 64 KB blocks; a 200 response (server ignores Range) marks the
 * source dead and every read rejects from then on.
 */
export function fromURL(url: string): ByteSource {
    const blocks = new Map<number, Promise<Uint8Array>>();
    let dead: Error | null = null;

    async function fetchRange(start: number, end: number): Promise<Uint8Array> {
        const response = await fetch(url, {
            headers: { Range: `bytes=${start}-${end - 1}` },
        });
        if (response.status === 200) {
            // Server ignores Range: give up rather than re-download the whole
            // file on every read; the caller's UI degrades.
            void response.body?.cancel();
            dead = new Error('server does not support HTTP range requests');
            throw dead;
        }
        if (response.status !== 206) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        // Content-Range is "bytes start-end/total"; the total is the file size.
        const total = /\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '');
        if (total) {
            source.size = Number(total[1]);
        }
        return new Uint8Array(await response.arrayBuffer());
    }

    function block(index: number): Promise<Uint8Array> {
        let cached = blocks.get(index);
        if (!cached) {
            cached = fetchRange(index * BLOCK_SIZE, (index + 1) * BLOCK_SIZE);
            // Don't cache transient failures (a dead source rejects up front).
            cached.catch(() => blocks.delete(index));
            blocks.set(index, cached);
        }
        return cached;
    }

    const source: ByteSource = {
        size: null,
        async read(start: number, end: number): Promise<Uint8Array> {
            if (dead) {
                throw dead;
            }
            if (start < 0 || end < start) {
                throw new Error(`invalid range [${start}, ${end})`);
            }
            if (start === end) {
                return new Uint8Array(0);
            }
            const first = Math.floor(start / BLOCK_SIZE);
            const last = Math.floor((end - 1) / BLOCK_SIZE);
            const parts = await Promise.all(
                Array.from({ length: last - first + 1 }, (_, i) => block(first + i))
            );
            const out = new Uint8Array(end - start);
            parts.forEach((part, i) => {
                const blockStart = (first + i) * BLOCK_SIZE;
                const from = Math.max(start, blockStart);
                const to = Math.min(end, blockStart + part.length);
                if (to > from) {
                    out.set(part.subarray(from - blockStart, to - blockStart), from - start);
                }
            });
            return out;
        },
    };
    return source;
}
