/** Message shapes exchanged between main thread and the parquet worker. */

interface ParseRequestBase {
    id: number;
    name: string;
    /** Absolute URL of the wheel manifest, resolved against the document. */
    manifestUrl: string;
    warmup?: undefined;
}

/**
 * Pre-boots pyodide (sent at page load) so the runtime is warm -- or already
 * up -- by the time the user provides a parquet file. Fire-and-forget: no
 * response; a failed warm boot is retried by the first real parse.
 */
export interface WarmupRequest {
    warmup: true;
    manifestUrl: string;
}

/** Parse locally-provided bytes (upload/drop). */
export interface ParseBytesRequest extends ParseRequestBase {
    /** Raw parquet bytes; transferred (not copied) to the worker. */
    bytes: ArrayBuffer;
    url?: undefined;
}

/** Parse a remote file in place via HTTP range requests (no full download). */
export interface ParseUrlRequest extends ParseRequestBase {
    url: string;
    bytes?: undefined;
}

export type ParseRequest = ParseBytesRequest | ParseUrlRequest;

/** Everything the main thread can send to the worker. */
export type WorkerRequest = ParseRequest | WarmupRequest;

export interface ParseSuccess {
    id: number;
    ok: true;
    dump: string;
}

export interface ParseFailure {
    id: number;
    ok: false;
    error: string;
}

/** Unsolicited boot/parse progress, surfaced in the loading-status element. */
export interface StatusEvent {
    status: string;
    detail?: undefined;
    progress?: undefined;
}

/**
 * Fine-grained progress under the current status (e.g. per-package downloads
 * during boot). Each one overwrites the previous in the loading-detail line.
 */
export interface DetailEvent {
    detail: string;
    status?: undefined;
    progress?: undefined;
}

/**
 * Fractional (0..1) download progress for the current phase; swaps the
 * loading spinner for a progress bar. Reset by the next status change.
 */
export interface ProgressEvent {
    progress: number;
    status?: undefined;
    detail?: undefined;
}

export type WorkerResponse =
    ParseSuccess | ParseFailure | StatusEvent | DetailEvent | ProgressEvent;
