/** Message shapes exchanged between main thread and the parquet worker. */

interface ParseRequestBase {
    id: number;
    name: string;
    /** Absolute URL of the wheel manifest, resolved against the document. */
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
}

export type WorkerResponse = ParseSuccess | ParseFailure | StatusEvent;
