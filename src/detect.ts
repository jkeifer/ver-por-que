/** Parquet files start (and end) with the 4-byte magic number "PAR1". */
const PARQUET_MAGIC = [0x50, 0x41, 0x52, 0x31]; // 'P','A','R','1'

/**
 * Detects parquet by magic bytes, falling back to the .parquet extension when
 * the header is inconclusive (e.g. a truncated read). Magic wins over the name.
 */
export function isParquet(head: Uint8Array, name?: string): boolean {
    if (head.length >= 4 && PARQUET_MAGIC.every((b, i) => head[i] === b)) {
        return true;
    }
    return name !== undefined && name.toLowerCase().endsWith('.parquet');
}

/**
 * Returns the source string when it's a fetchable http(s) URL, else null. Used
 * to decide whether a JSON/restored dump can be re-fetched from its recorded
 * `source` (range-read for hex, or re-parsed for bloom/preview). Only checks
 * that it parses as an http(s) URL — CORS/auth/404 are only knowable by trying,
 * and the fetch paths already degrade gracefully on failure.
 */
export function httpUrlOrNull(source: string | null | undefined): string | null {
    if (!source) {
        return null;
    }
    try {
        const { protocol } = new URL(source);
        return protocol === 'http:' || protocol === 'https:' ? source : null;
    } catch {
        return null;
    }
}

/**
 * Detects a remote parquet file by its URL path (query/hash ignored). No bytes
 * are available before deciding whether to range-read the file, so this is
 * extension-only: a parquet URL without the extension just takes the
 * download-and-sniff path instead.
 */
export function isParquetURL(url: string): boolean {
    try {
        return isParquet(new Uint8Array(), new URL(url).pathname);
    } catch {
        return false;
    }
}
