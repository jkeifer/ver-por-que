/** Message shapes exchanged between main thread and the parquet worker. */
import type {
    BloomDensityResult,
    BloomProbeResult,
    DictionaryPreviewResult,
    PreviewResult,
} from './pyodide-parquet';

interface ParseRequestBase {
    id: number;
    name: string;
    /** Absolute URL of the wheel manifest, resolved against the document. */
    manifestUrl: string;
    warmup?: undefined;
    probe?: undefined;
    preview?: undefined;
    dictionaryPreview?: undefined;
    bloomDensity?: undefined;
    bloomBlock?: undefined;
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
    dictionaryPreview?: undefined;
    bloomDensity?: undefined;
    bloomBlock?: undefined;
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
    dictionaryPreview?: undefined;
    bloomDensity?: undefined;
    bloomBlock?: undefined;
    boot?: undefined;
    bytes?: undefined;
    url?: undefined;
}

/**
 * Read a column chunk's whole bloom filter and reduce it to a density strip in
 * the worker's current file. Returns the block count, overall fill, and the
 * per-bucket fill fractions (BloomDensityResult).
 */
export interface BloomDensityRequest {
    id: number;
    manifestUrl: string;
    bloomDensity: { rowGroup: number; column: string };
    warmup?: undefined;
    probe?: undefined;
    preview?: undefined;
    dictionaryPreview?: undefined;
    bloomBlock?: undefined;
    boot?: undefined;
    bytes?: undefined;
    url?: undefined;
}

/**
 * Read one 256-bit block's 32 raw bytes (base64) from a column chunk's bloom
 * filter in the worker's current file, so the UI can render any block's bit-grid
 * on demand at any filter size.
 */
export interface BloomBlockRequest {
    id: number;
    manifestUrl: string;
    bloomBlock: { rowGroup: number; column: string; blockIndex: number };
    warmup?: undefined;
    probe?: undefined;
    preview?: undefined;
    dictionaryPreview?: undefined;
    bloomDensity?: undefined;
    boot?: undefined;
    bytes?: undefined;
    url?: undefined;
}

/**
 * Decode one `[offset, offset+limit)` window of a data page in the worker's
 * current file (the page is decoded once and cached, so pagination re-slices
 * rather than re-decodes). Codec-unavailable failures come back as a typed
 * success payload (PreviewResult), never an error response.
 */
export interface PreviewRequest {
    id: number;
    manifestUrl: string;
    preview: {
        rowGroup: number;
        column: string;
        pageIndex: number;
        offset: number;
        limit: number;
        skipNulls: boolean;
    };
    warmup?: undefined;
    probe?: undefined;
    dictionaryPreview?: undefined;
    bloomDensity?: undefined;
    bloomBlock?: undefined;
    boot?: undefined;
    bytes?: undefined;
    url?: undefined;
}

/**
 * Decode one `[offset, offset+limit)` window of a column chunk's dictionary
 * page (its distinct values) in the worker's current file. Decoded once and
 * cached, like PreviewRequest. Codec-unavailable failures come back as a typed
 * success payload (DictionaryPreviewResult), never an error response.
 */
export interface DictionaryPreviewRequest {
    id: number;
    manifestUrl: string;
    dictionaryPreview: { rowGroup: number; column: string; offset: number; limit: number };
    warmup?: undefined;
    probe?: undefined;
    preview?: undefined;
    bloomDensity?: undefined;
    bloomBlock?: undefined;
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
    dictionaryPreview?: undefined;
    bloomDensity?: undefined;
    bloomBlock?: undefined;
    bytes?: undefined;
    url?: undefined;
}

/** Everything the main thread can send to the worker. */
export type WorkerRequest =
    | ParseRequest
    | ProbeBloomRequest
    | BloomDensityRequest
    | BloomBlockRequest
    | PreviewRequest
    | DictionaryPreviewRequest
    | BootRequest
    | WarmupRequest;

export interface ParseSuccess {
    id: number;
    ok: true;
    dump: string;
    bloomProbe?: undefined;
    bloomDensity?: undefined;
    bloomBlock?: undefined;
    preview?: undefined;
    dictionaryPreview?: undefined;
    booted?: undefined;
}

export interface ProbeBloomSuccess {
    id: number;
    ok: true;
    /** The probe's full split-block derivation; `.mightContain` is the verdict
     *  (false is exact absence, true is only ever a maybe). */
    bloomProbe: BloomProbeResult;
    dump?: undefined;
    bloomDensity?: undefined;
    bloomBlock?: undefined;
    preview?: undefined;
    dictionaryPreview?: undefined;
    booted?: undefined;
}

export interface BloomDensitySuccess {
    id: number;
    ok: true;
    /** The whole filter reduced to a density strip (blocks, fill, buckets). */
    bloomDensity: BloomDensityResult;
    dump?: undefined;
    bloomProbe?: undefined;
    bloomBlock?: undefined;
    preview?: undefined;
    dictionaryPreview?: undefined;
    booted?: undefined;
}

export interface BloomBlockSuccess {
    id: number;
    ok: true;
    /** One 256-bit block's 32 raw bytes, base64. */
    bloomBlock: string;
    dump?: undefined;
    bloomProbe?: undefined;
    bloomDensity?: undefined;
    preview?: undefined;
    dictionaryPreview?: undefined;
    booted?: undefined;
}

export interface PreviewSuccess {
    id: number;
    ok: true;
    preview: PreviewResult;
    dump?: undefined;
    bloomProbe?: undefined;
    bloomDensity?: undefined;
    bloomBlock?: undefined;
    dictionaryPreview?: undefined;
    booted?: undefined;
}

export interface DictionaryPreviewSuccess {
    id: number;
    ok: true;
    dictionaryPreview: DictionaryPreviewResult;
    dump?: undefined;
    bloomProbe?: undefined;
    bloomDensity?: undefined;
    bloomBlock?: undefined;
    preview?: undefined;
    booted?: undefined;
}

/** Acknowledges a BootRequest; carries no payload. */
export interface BootSuccess {
    id: number;
    ok: true;
    booted: true;
    dump?: undefined;
    bloomProbe?: undefined;
    bloomDensity?: undefined;
    bloomBlock?: undefined;
    preview?: undefined;
    dictionaryPreview?: undefined;
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
    | BloomDensitySuccess
    | BloomBlockSuccess
    | PreviewSuccess
    | DictionaryPreviewSuccess
    | BootSuccess
    | ParseFailure
    | StatusEvent
    | DetailEvent
    | ProgressEvent;
