/**
 * Fetches a URL into bytes, streaming the body so download progress (0..1)
 * can be reported when the server sends Content-Length. Falls back to a
 * plain buffered read when the size is unknown or nobody is listening.
 * Shared by the main thread (remote file fetch) and the parquet worker
 * (whole-file CORS fallback).
 */
export async function fetchBytes(
    url: string,
    onProgress?: (fraction: number) => void
): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
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
