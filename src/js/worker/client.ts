/**
 * Main-thread handle to the parquet worker. Spins the worker up on first use
 * (so the JSON path pays zero pyodide cost) and reuses it thereafter.
 */
import type { WorkerRequest, WorkerResponse } from './protocol';
import type {
    BloomDensityResult,
    BloomProbeResult,
    DictionaryPreviewResult,
    PreviewResult,
} from './pyodide-parquet';

/** An id-bearing request (i.e. one that expects a reply, not fire-and-forget). */
type Ask = Extract<WorkerRequest, { id: number }>;
/** The kinds of request that expect a reply. */
type AskKind = Ask['kind'];
/** A request payload with `id`/`manifestUrl` stripped (the client fills those). */
type AskPayload<K extends AskKind> = Omit<Extract<Ask, { kind: K }>, 'id' | 'manifestUrl'>;
/** A response that answers a request (has an `id`), as opposed to an event. */
type Reply = Extract<WorkerResponse, { id: number }>;
/** The success reply tagged with a given `kind`. */
type SuccessOf<K extends Reply['kind']> = Extract<Reply, { kind: K; ok: true }>;

interface Pending {
    resolve: (msg: Reply) => void;
    reject: (error: Error) => void;
}

export class ParquetWorkerClient {
    private worker: Worker | null = null;
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();

    constructor(
        private readonly onStatus: (status: string) => void,
        private readonly onDetail: (detail: string) => void = () => {},
        private readonly onProgress: (fraction: number) => void = () => {}
    ) {}

    private ensureWorker(): Worker {
        if (!this.worker) {
            this.worker = new Worker(new URL('./worker.ts', import.meta.url), {
                type: 'module',
            });
            this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) =>
                this.handle(event.data)
            );
            // A worker that dies (script load failure, uncaught boot error)
            // never answers; without this, every pending parse hangs forever.
            this.worker.addEventListener('error', (event: ErrorEvent) => this.fail(event));
        }
        return this.worker;
    }

    private fail(event: ErrorEvent): void {
        const error = new Error(event.message || 'parquet worker crashed');
        for (const { reject } of this.pending.values()) {
            reject(error);
        }
        this.pending.clear();
        this.worker?.terminate();
        this.worker = null;
    }

    private handle(msg: WorkerResponse): void {
        switch (msg.kind) {
            case 'status':
                this.onStatus(msg.status);
                return;
            case 'detail':
                this.onDetail(msg.detail);
                return;
            case 'progress':
                this.onProgress(msg.progress);
                return;
        }
        const entry = this.pending.get(msg.id);
        if (!entry) {
            return;
        }
        this.pending.delete(msg.id);
        if (msg.ok) {
            entry.resolve(msg);
        } else {
            entry.reject(new Error(msg.error));
        }
    }

    /** Parses raw parquet bytes into a por-que dump JSON string. */
    parse(bytes: ArrayBuffer, name: string): Promise<string> {
        return this.request({ kind: 'parse', name, bytes }, [bytes]).then(msg => msg.dump);
    }

    /**
     * Parses a remote parquet URL into a por-que dump JSON string. The worker
     * reads it in place via HTTP range requests, falling back to a whole-file
     * download when the server (or CORS) doesn't support ranges.
     */
    parseURL(url: string): Promise<string> {
        return this.request({ kind: 'parse', name: url, url }).then(msg => msg.dump);
    }

    /**
     * Probes a bloom filter in the worker's current file (the one it parsed
     * last), returning the full split-block derivation. `.mightContain` is the
     * verdict: false is exact -- definitely absent; true is only ever a maybe.
     */
    probeBloom(rowGroup: number, column: string, value: string): Promise<BloomProbeResult> {
        return this.request({ kind: 'probe', rowGroup, column, value }).then(msg => msg.bloomProbe);
    }

    /**
     * Reads a column chunk's whole bloom filter in the worker's current file and
     * reduces it to a density strip (block count, overall fill, per-bucket fills).
     */
    bloomDensity(rowGroup: number, column: string): Promise<BloomDensityResult> {
        return this.request({ kind: 'bloomDensity', rowGroup, column }).then(
            msg => msg.bloomDensity
        );
    }

    /**
     * Reads a contiguous run of `count` 256-bit blocks' raw bytes (base64) from a
     * column chunk's bloom filter in the worker's current file, so a window of
     * block bit-grids renders on demand at any filter size in one call.
     */
    bloomBlocks(rowGroup: number, column: string, start: number, count: number): Promise<string> {
        return this.request({ kind: 'bloomBlocks', rowGroup, column, start, count }).then(
            msg => msg.bloomBlocks
        );
    }

    /**
     * Decodes a window of a data page in the worker's current file, starting at
     * value `offset`. With `skipNulls`, the window is up to `limit` non-null
     * values. The page is decoded once and cached, so paging is cheap.
     * Codec-unavailable results resolve (typed), never reject.
     */
    preview(
        rowGroup: number,
        column: string,
        pageIndex: number,
        offset: number,
        limit: number,
        skipNulls: boolean
    ): Promise<PreviewResult> {
        return this.request({
            kind: 'preview',
            rowGroup,
            column,
            pageIndex,
            offset,
            limit,
            skipNulls,
        }).then(msg => msg.preview);
    }

    /**
     * Decodes a window of a column chunk's dictionary page (its distinct values)
     * in the worker's current file. Decoded once and cached, so paging is cheap.
     * Codec-unavailable results resolve (typed), never reject.
     */
    previewDictionary(
        rowGroup: number,
        column: string,
        offset: number,
        limit: number
    ): Promise<DictionaryPreviewResult> {
        return this.request({
            kind: 'dictionaryPreview',
            rowGroup,
            column,
            offset,
            limit,
        }).then(msg => msg.dictionaryPreview);
    }

    /**
     * Rehydrates a full dump into the worker's current-file slot and attaches a
     * range reader at `url`, so probeBloom/preview work on a JSON-loaded dump
     * without re-parsing the file. One-time per dump; the caller memoizes.
     */
    bootFromDump(dumpJson: string, url: string): Promise<void> {
        return this.request({ kind: 'boot', dumpJson, url }).then(() => undefined);
    }

    /**
     * Starts booting pyodide in the background (fire-and-forget) so the
     * runtime is warm -- or already up -- before the first parse.
     */
    warmUp(): void {
        this.ensureWorker().postMessage({ kind: 'warmup', manifestUrl: manifestUrl() });
    }

    /**
     * Fire-and-forget: warm the current file's bloom filter byte ranges into the
     * reader's block cache, so the first probe/density render pays no range
     * fetch. Sent after a parse/boot resolves (the worker must have a file).
     */
    prefetchBlooms(): void {
        this.ensureWorker().postMessage({ kind: 'prefetchBlooms', manifestUrl: manifestUrl() });
    }

    /**
     * Sends one id-bearing request and resolves with its success reply. The
     * caller supplies everything but `id`/`manifestUrl` (both filled here); the
     * response kind matches the request kind, so the returned type narrows to
     * exactly that success shape -- no post-hoc assertions needed.
     */
    private request<K extends AskKind>(
        payload: AskPayload<K> & { kind: K },
        transfer: Transferable[] = []
    ): Promise<SuccessOf<K>> {
        const worker = this.ensureWorker();
        const id = this.nextId++;
        return new Promise<Reply>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            const req = { id, manifestUrl: manifestUrl(), ...payload } as unknown as WorkerRequest;
            worker.postMessage(req, transfer);
        }) as Promise<SuccessOf<K>>;
    }
}

function manifestUrl(): string {
    return new URL('vendor/manifest.json', document.baseURI).href;
}
