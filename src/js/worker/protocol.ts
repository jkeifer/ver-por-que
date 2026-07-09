/**
 * Message shapes exchanged between main thread and the parquet worker. Requests
 * and responses are tagged unions: every variant carries a `kind` discriminant,
 * so both ends narrow on the tag rather than probing for defined keys. Adding a
 * message type costs only its own variant -- no per-variant padding to maintain.
 */
import type {
    BloomDensityResult,
    BloomProbeResult,
    DictionaryPreviewResult,
    PreviewResult,
} from './pyodide-parquet';

/**
 * Parse a parquet file. Exactly one source is set: `bytes` (locally-provided
 * upload/drop, transferred not copied) or `url` (a remote file read in place via
 * HTTP range requests, no full download). The worker branches on which is present.
 */
export interface ParseRequest {
    kind: 'parse';
    id: number;
    name: string;
    /** Absolute URL of the wheel manifest, resolved against the document. */
    manifestUrl: string;
    /** Raw parquet bytes; transferred (not copied) to the worker. */
    bytes?: ArrayBuffer;
    url?: string;
}

/**
 * Pre-boots pyodide (sent at page load) so the runtime is warm -- or already
 * up -- by the time the user provides a parquet file. Fire-and-forget: no
 * response; a failed warm boot is retried by the first real parse.
 */
export interface WarmupRequest {
    kind: 'warmup';
    manifestUrl: string;
}

/**
 * Probe a column chunk's bloom filter in the worker's current file (the most
 * recently parsed one). The value is a string; the python side coerces it to
 * the column's physical type (string transport is BigInt-safe for INT64).
 */
export interface ProbeBloomRequest {
    kind: 'probe';
    id: number;
    manifestUrl: string;
    rowGroup: number;
    column: string;
    value: string;
}

/**
 * Read a column chunk's whole bloom filter and reduce it to a density strip in
 * the worker's current file. Returns the block count, overall fill, and the
 * per-bucket fill fractions (BloomDensityResult).
 */
export interface BloomDensityRequest {
    kind: 'bloomDensity';
    id: number;
    manifestUrl: string;
    rowGroup: number;
    column: string;
}

/**
 * Read a contiguous run of `count` 256-bit blocks' raw bytes (base64) from a
 * column chunk's bloom filter in the worker's current file, so the UI can render
 * a window of block bit-grids on demand at any filter size in one call.
 */
export interface BloomBlocksRequest {
    kind: 'bloomBlocks';
    id: number;
    manifestUrl: string;
    rowGroup: number;
    column: string;
    start: number;
    count: number;
}

/**
 * Decode one `[offset, offset+limit)` window of a data page in the worker's
 * current file (the page is decoded once and cached, so pagination re-slices
 * rather than re-decodes). Codec-unavailable failures come back as a typed
 * success payload (PreviewResult), never an error response.
 */
export interface PreviewRequest {
    kind: 'preview';
    id: number;
    manifestUrl: string;
    rowGroup: number;
    column: string;
    pageIndex: number;
    offset: number;
    limit: number;
    skipNulls: boolean;
}

/**
 * Decode one `[offset, offset+limit)` window of a column chunk's dictionary
 * page (its distinct values) in the worker's current file. Decoded once and
 * cached, like PreviewRequest. Codec-unavailable failures come back as a typed
 * success payload (DictionaryPreviewResult), never an error response.
 */
export interface DictionaryPreviewRequest {
    kind: 'dictionaryPreview';
    id: number;
    manifestUrl: string;
    rowGroup: number;
    column: string;
    offset: number;
    limit: number;
}

/**
 * Rehydrate a full dump into the worker's current-file slot and attach a
 * range-reading reader at `url`. Lets bloom/preview run against a JSON-loaded
 * dump without re-parsing the file (the dump already holds every offset).
 */
export interface BootRequest {
    kind: 'boot';
    id: number;
    manifestUrl: string;
    dumpJson: string;
    url: string;
}

/**
 * Warm the reader's block cache for every bloom filter in the worker's current
 * file (sent right after a load). Fire-and-forget: no response — the first probe
 * simply finds the byte ranges already cached. Requires a loaded file, so it's
 * sent only after a parse/boot has resolved.
 */
export interface PrefetchBloomsRequest {
    kind: 'prefetchBlooms';
    manifestUrl: string;
}

/** Everything the main thread can send to the worker. */
export type WorkerRequest =
    | ParseRequest
    | ProbeBloomRequest
    | BloomDensityRequest
    | BloomBlocksRequest
    | PreviewRequest
    | DictionaryPreviewRequest
    | BootRequest
    | WarmupRequest
    | PrefetchBloomsRequest;

export interface ParseSuccess {
    kind: 'parse';
    id: number;
    ok: true;
    dump: string;
}

export interface ProbeBloomSuccess {
    kind: 'probe';
    id: number;
    ok: true;
    /** The probe's full split-block derivation; `.mightContain` is the verdict
     *  (false is exact absence, true is only ever a maybe). */
    bloomProbe: BloomProbeResult;
}

export interface BloomDensitySuccess {
    kind: 'bloomDensity';
    id: number;
    ok: true;
    /** The whole filter reduced to a density strip (blocks, fill, buckets). */
    bloomDensity: BloomDensityResult;
}

export interface BloomBlocksSuccess {
    kind: 'bloomBlocks';
    id: number;
    ok: true;
    /** A contiguous run of 256-bit blocks' raw bytes, base64 (count*32 bytes). */
    bloomBlocks: string;
}

export interface PreviewSuccess {
    kind: 'preview';
    id: number;
    ok: true;
    preview: PreviewResult;
}

export interface DictionaryPreviewSuccess {
    kind: 'dictionaryPreview';
    id: number;
    ok: true;
    dictionaryPreview: DictionaryPreviewResult;
}

/** Acknowledges a BootRequest; carries no payload. */
export interface BootSuccess {
    kind: 'boot';
    id: number;
    ok: true;
}

export interface ParseFailure {
    kind: 'failure';
    id: number;
    ok: false;
    error: string;
}

/** Unsolicited boot/parse progress, surfaced in the loading-status element. */
export interface StatusEvent {
    kind: 'status';
    status: string;
}

/**
 * Fine-grained progress under the current status (e.g. per-package downloads
 * during boot). Each one overwrites the previous in the loading-detail line.
 */
export interface DetailEvent {
    kind: 'detail';
    detail: string;
}

/**
 * Fractional (0..1) download progress for the current phase; swaps the
 * loading spinner for a progress bar. Reset by the next status change.
 */
export interface ProgressEvent {
    kind: 'progress';
    progress: number;
}

export type WorkerResponse =
    | ParseSuccess
    | ProbeBloomSuccess
    | BloomDensitySuccess
    | BloomBlocksSuccess
    | PreviewSuccess
    | DictionaryPreviewSuccess
    | BootSuccess
    | ParseFailure
    | StatusEvent
    | DetailEvent
    | ProgressEvent;
