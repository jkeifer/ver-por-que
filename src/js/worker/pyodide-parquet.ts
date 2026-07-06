/**
 * Boots pyodide and runs por-que against a parquet source -- raw bytes or a
 * remote URL -- returning the same dump JSON string that `por-que dump`
 * produces server-side. URLs are read in place via HTTP range requests
 * (hctef's AsyncHttpFile), falling back to a whole-file download when the
 * server (or CORS) doesn't support ranges.
 *
 * This module is deliberately worker-agnostic: it takes `loadPyodide` and a
 * wheel loader as parameters so it can run under a real Web Worker in the
 * browser AND under plain node in vitest (test/pyodide-parquet.*.test.ts).
 * The actual worker file (worker.ts) is a thin postMessage shell around this.
 */

// Type-only: erased at build time, so the browser bundle never imports the
// npm pyodide package (it loads the runtime from the CDN instead).
import type { PyodideInterface } from 'pyodide';

export type LoadPyodide = (options?: { indexURL?: string }) => Promise<PyodideInterface>;

export interface WheelAsset {
    filename: string;
    bytes: Uint8Array;
}

export interface ParquetParserDeps {
    loadPyodide: LoadPyodide;
    /** Fetches the wheels to install (hctef + por-que). Lazy: only called during boot. */
    loadWheels: () => Promise<WheelAsset[]>;
    /** Where pyodide's core files live. Omit under node (npm ships them). */
    indexURL?: string;
    /** Surfaces coarse boot/parse progress to the UI. */
    onStatus?: (status: string) => void;
}

/** A parse input: raw parquet bytes, or a remote URL read via range requests. */
export type ParquetSource = Uint8Array | { url: string };

/** Parses a parquet source into a por-que dump JSON string. */
export type ParquetParser = (source: ParquetSource, name: string) => Promise<string>;

const PARSE_PY = `
import io
from por_que import AsyncHttpFile, ParquetFile

async def _dump(data, name):
    pf = await ParquetFile.from_reader(io.BytesIO(bytes(data.to_py())), name)
    return pf.to_json()

async def _dump_url(url):
    # AsyncHttpFile auto-selects hctef's pyfetch transport under emscripten
    # (browser fetch; node's global fetch under vitest) and reads via HTTP
    # range requests through a block cache, so only the byte ranges the
    # parser touches are downloaded.
    async with AsyncHttpFile(url) as f:
        pf = await ParquetFile.from_reader(f, url)
        return pf.to_json()
`;

/**
 * True when a python error bubbled up from hctef's network layer -- most
 * commonly the range probe failing because the server doesn't support range
 * requests, or CORS hides Content-Range (missing Access-Control-Expose-Headers).
 * Pyodide surfaces python exceptions as JS Errors whose message embeds the
 * python traceback, so match on the exception class name.
 */
function isHctefNetworkError(error: unknown): boolean {
    return error instanceof Error && error.message.includes('HctefNetworkError');
}

/**
 * Boots pyodide once and returns a parser. Boot is expensive (~12MB runtime on
 * first browser load); reuse the returned parser across files.
 */
export async function createParquetParser(deps: ParquetParserDeps): Promise<ParquetParser> {
    const status = deps.onStatus ?? (() => {});

    status('Loading Python runtime...');
    const pyodide = await deps.loadPyodide(deps.indexURL ? { indexURL: deps.indexURL } : undefined);

    status('Installing dependencies...');
    // Compiled wheels bundled with the pyodide distribution. No aiohttp:
    // hctef.aio now imports without it and uses its pyfetch transport here.
    await pyodide.loadPackage(['micropip', 'pydantic', 'zstandard', 'brotli']);

    // micropip's PyProxy is untyped; keep the surface we use narrow.
    const micropip = pyodide.pyimport('micropip') as {
        install: {
            callKwargs(spec: string, kwargs: { deps: boolean }): Promise<void>;
        };
    };

    status('Installing por-que...');
    // deps=False: everything the wheels need is already loaded above, and
    // por-que's declared deps include no-pure-wheel packages (cramjam via
    // hctef[async], python-snappy) that we intentionally skip -- the structure
    // dump never decompresses page content. The wheel filenames must stay
    // intact (micropip parses name/version from them).
    // ponytail: local wheels because the PyPI releases predate the current
    // dump format (por-que) and the pyfetch transport (hctef); pin PyPI
    // versions here once releases ship them.
    for (const wheel of await deps.loadWheels()) {
        const wheelPath = `/tmp/${wheel.filename}`;
        pyodide.FS.writeFile(wheelPath, wheel.bytes);
        await micropip.install.callKwargs(`emfs:${wheelPath}`, { deps: false });
    }

    await pyodide.runPythonAsync(PARSE_PY);
    const dump = pyodide.globals.get('_dump') as (
        data: Uint8Array,
        name: string
    ) => Promise<string>;
    const dumpUrl = pyodide.globals.get('_dump_url') as (url: string) => Promise<string>;

    const parseBytes = async (bytes: Uint8Array, name: string): Promise<string> => {
        status('Parsing parquet...');
        return dump(bytes, name);
    };

    return async (source: ParquetSource, name: string): Promise<string> => {
        if (source instanceof Uint8Array) {
            return parseBytes(source, name);
        }
        const { url } = source;
        status('Parsing parquet (HTTP range requests)...');
        try {
            return await dumpUrl(url);
        } catch (error) {
            if (!isHctefNetworkError(error)) {
                throw error;
            }
            // The user explicitly wants this fallback: range requests need
            // server cooperation (Range support + CORS exposing
            // Content-Range), and a whole-file download usually still works.
            console.warn(
                `Range requests unavailable for ${url} (likely CORS: the server ` +
                    'must expose Content-Range via Access-Control-Expose-Headers); ' +
                    'falling back to downloading the whole file.',
                error
            );
            status('Range requests unavailable; downloading whole file...');
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return parseBytes(new Uint8Array(await response.arrayBuffer()), name);
        }
    };
}
