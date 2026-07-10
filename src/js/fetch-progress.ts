/**
 * Fetches a URL into bytes, streaming the body so download progress (0..1)
 * can be reported when the server sends Content-Length. Falls back to a
 * plain buffered read when the size is unknown or nobody is listening.
 * Shared by the main thread (remote file fetch) and the parquet worker
 * (whole-file CORS fallback).
 */

/** A non-ok response, carrying the status so retry logic can classify it. */
class HttpError extends Error {
    constructor(
        readonly status: number,
        statusText: string
    ) {
        super(`HTTP ${status}: ${statusText}`);
    }
}

const RETRY_DELAYS_MS = [1000, 3000];

/**
 * One transient failure must not be terminal: this GET often runs right after
 * a burst of failing range reads on the same HTTP/2 connection (e.g.
 * data.source.coop 500s concurrent range GETs, and browsers mask the CORS-less
 * error responses as generic fetch failures), so the first attempt can inherit
 * a poisoned connection. Retry network failures and 5xx/429 after a pause that
 * lets the in-flight requests settle; client errors (4xx) fail immediately.
 */
export async function fetchBytes(
    url: string,
    onProgress?: (fraction: number) => void
): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fetchBytesOnce(url, onProgress);
        } catch (error) {
            const permanent =
                error instanceof HttpError && error.status < 500 && error.status !== 429;
            if (permanent || attempt >= RETRY_DELAYS_MS.length) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
        }
    }
}

async function fetchBytesOnce(
    url: string,
    onProgress?: (fraction: number) => void
): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new HttpError(response.status, response.statusText);
    }

    const total = Number(response.headers.get('content-length'));
    if (!response.body || !total || !onProgress) {
        return new Uint8Array(await response.arrayBuffer());
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
        received += value.length;
        // Content-Length is the encoded size, but the reader yields decoded
        // bytes, so a compressed response can overshoot; clamp it.
        onProgress(Math.min(received / total, 1));
    }

    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return bytes;
}
