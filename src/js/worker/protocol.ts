/** Message shapes exchanged between main thread and the parquet worker. */
import type { PreviewResult } from './pyodide-parquet';

interface ParseRequestBase {
    id: number;
    name: string;
    /** Absolute URL of the wheel manifest, resolved against the document. */
    manifestUrl: string;
    warmup?: undefined;
    probe?: undefined;
    preview?: undefined;
    boot?: undefined;
}

/**
 * Pre-boots pyodide (sent at page load) so the runtime is warm -- or already
 * up -- by the time the user provides a parquet file. Fire-and-forget: no
 * response; a failed warm boot is retried by the first real parse.
 */
export interface WarmupRequest {
    warmup: true;
    manifestUrl: string;
    probe?: undefined;
    preview?: undefined;
    boot?: undefined;
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

/**
 * Probe a column chunk's bloom filter in the worker's current file (the most
 * recently parsed one). The value is a string; the python side coerces it to
 * the column's physical type (string transport is BigInt-safe for INT64).
 */
export interface ProbeBloomRequest {
    id: number;
    manifestUrl: string;
    probe: { rowGroup: number; column: string; value: string };
    warmup?: undefined;
    preview?: undefined;
    boot?: undefined;
    bytes?: undefined;
    url?: undefined;
}

/**
 * Decode the first `maxValues` values of a column chunk in the worker's
 * current file. Codec-unavailable failures come back as a typed success
 * payload (PreviewResult), never an error response.
 */
export interface PreviewRequest {
    id: number;
    manifestUrl: string;
    preview: { rowGroup: number; column: string; maxValues: number };
    warmup?: undefined;
    probe?: undefined;
    boot?: undefined;
    bytes?: undefined;
    url?: undefined;
}

/**
 * Rehydrate a full dump into the worker's current-file slot and attach a
 * range-reading reader at `url`. Lets bloom/preview run against a JSON-loaded
 * dump without re-parsing the file (the dump already holds every offset).
 */
export interface BootRequest {
    id: number;
    manifestUrl: string;
    boot: { dumpJson: string; url: string };
    warmup?: undefined;
    probe?: undefined;
    preview?: undefined;
    bytes?: undefined;
    url?: undefined;
}

/** Everything the main thread can send to the worker. */
export type WorkerRequest =
    ParseRequest | ProbeBloomRequest | PreviewRequest | BootRequest | WarmupRequest;

export interface ParseSuccess {
    id: number;
    ok: true;
    dump: string;
    mightContain?: undefined;
    preview?: undefined;
    booted?: undefined;
}

export interface ProbeBloomSuccess {
    id: number;
    ok: true;
    /** False is exact (definitely absent); true is only ever a maybe. */
    mightContain: boolean;
    dump?: undefined;
    preview?: undefined;
    booted?: undefined;
}

export interface PreviewSuccess {
    id: number;
    ok: true;
    preview: PreviewResult;
    dump?: undefined;
    mightContain?: undefined;
    booted?: undefined;
}

/** Acknowledges a BootRequest; carries no payload. */
export interface BootSuccess {
    id: number;
    ok: true;
    booted: true;
    dump?: undefined;
    mightContain?: undefined;
    preview?: undefined;
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
    | ParseSuccess
    | ProbeBloomSuccess
    | PreviewSuccess
    | BootSuccess
    | ParseFailure
    | StatusEvent
    | DetailEvent
    | ProgressEvent;
