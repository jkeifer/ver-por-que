/**
 * Thin worker shell around pyodide-parquet.ts. Boots pyodide lazily on the
 * first parse request and reuses it across subsequent files.
 */
import {
    createParquetParser,
    type LoadPyodide,
    type ParquetParser,
    type WheelAsset,
} from './pyodide-parquet';
import type { ParseRequest, WorkerResponse } from './protocol';

// Keep this equal to the `pyodide` devDep version in package.json: the worker
// loads the runtime from the CDN, the integration test loads it from the npm
// package, and they must be the same build.
const PYODIDE_VERSION = '314.0.2';
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

// Worker globals, typed locally so this file needs neither the DOM's `self`
// (whose postMessage signature is wrong for workers) nor the WebWorker lib.
interface WorkerContext {
    postMessage(msg: WorkerResponse): void;
    addEventListener(type: 'message', handler: (event: MessageEvent<ParseRequest>) => void): void;
}
const ctx = globalThis as unknown as WorkerContext;

let parserPromise: Promise<ParquetParser> | null = null;

async function loadWheels(manifestUrl: string): Promise<WheelAsset[]> {
    const manifest = (await (await fetch(manifestUrl)).json()) as {
        wheel: string;
        hctef: string;
    };
    const load = async (filename: string): Promise<WheelAsset> => {
        const wheelUrl = new URL(filename, manifestUrl).href;
        const bytes = new Uint8Array(await (await fetch(wheelUrl)).arrayBuffer());
        return { filename, bytes };
    };
    return Promise.all([manifest.hctef, manifest.wheel].map(load));
}

function getParser(manifestUrl: string): Promise<ParquetParser> {
    if (!parserPromise) {
        parserPromise = (async () => {
            // Module worker: pull pyodide's ESM straight from the CDN at
            // runtime. The URL is non-analyzable so the bundler leaves it as a
            // real dynamic import instead of trying to bundle 12MB of runtime.
            const pyodideUrl = `${PYODIDE_CDN}pyodide.mjs`;
            const mod = (await import(/* @vite-ignore */ pyodideUrl)) as {
                loadPyodide: LoadPyodide;
            };
            return createParquetParser({
                loadPyodide: mod.loadPyodide,
                indexURL: PYODIDE_CDN,
                loadWheels: () => loadWheels(manifestUrl),
                onStatus: status => ctx.postMessage({ status }),
            });
        })();
    }
    return parserPromise;
}

ctx.addEventListener('message', event => {
    const req = event.data;
    void (async () => {
        try {
            const parser = await getParser(req.manifestUrl);
            const source = req.url !== undefined ? { url: req.url } : new Uint8Array(req.bytes);
            const dump = await parser(source, req.name);
            ctx.postMessage({ id: req.id, ok: true, dump });
        } catch (error) {
            ctx.postMessage({ id: req.id, ok: false, error: (error as Error).message });
        }
    })();
});
