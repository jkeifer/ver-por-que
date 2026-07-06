/**
 * Main-thread handle to the parquet worker. Spins the worker up on first use
 * (so the JSON path pays zero pyodide cost) and reuses it thereafter.
 */
import type {
    ParseRequest,
    ParseSuccess,
    ProbeBloomRequest,
    ProbeBloomSuccess,
    WorkerResponse,
} from './protocol';

interface Pending {
    resolve: (msg: ParseSuccess | ProbeBloomSuccess) => void;
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
        if ('status' in msg && msg.status !== undefined) {
            this.onStatus(msg.status);
            return;
        }
        if ('detail' in msg && msg.detail !== undefined) {
            this.onDetail(msg.detail);
            return;
        }
        if ('progress' in msg && msg.progress !== undefined) {
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
        return this.request({ name, bytes }, [bytes]).then(msg => msg.dump!);
    }

    /**
     * Parses a remote parquet URL into a por-que dump JSON string. The worker
     * reads it in place via HTTP range requests, falling back to a whole-file
     * download when the server (or CORS) doesn't support ranges.
     */
    parseURL(url: string): Promise<string> {
        return this.request({ name: url, url }).then(msg => msg.dump!);
    }

    /**
     * Probes a bloom filter in the worker's current file (the one it parsed
     * last). False is exact -- definitely absent; true is only ever a maybe.
     */
    probeBloom(rowGroup: number, column: string, value: string): Promise<boolean> {
        return this.request({ probe: { rowGroup, column, value } }).then(msg => msg.mightContain!);
    }

    /**
     * Starts booting pyodide in the background (fire-and-forget) so the
     * runtime is warm -- or already up -- before the first parse.
     */
    warmUp(): void {
        this.ensureWorker().postMessage({ warmup: true, manifestUrl: manifestUrl() });
    }

    private request(
        payload:
            | ({ name: string } & ({ bytes: ArrayBuffer } | { url: string }))
            | { probe: ProbeBloomRequest['probe'] },
        transfer: Transferable[] = []
    ): Promise<ParseSuccess | ProbeBloomSuccess> {
        const worker = this.ensureWorker();
        const id = this.nextId++;
        return new Promise<ParseSuccess | ProbeBloomSuccess>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            const req = { id, manifestUrl: manifestUrl(), ...payload } as
                ParseRequest | ProbeBloomRequest;
            worker.postMessage(req, transfer);
        });
    }
}

function manifestUrl(): string {
    return new URL('vendor/manifest.json', document.baseURI).href;
}
