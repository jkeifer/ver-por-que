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

import { fetchBytes } from '../fetch-progress';

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
    /** Surfaces fine-grained sub-steps under the current status. */
    onDetail?: (detail: string) => void;
    /** Surfaces fractional (0..1) download progress where it's measurable. */
    onProgress?: (fraction: number) => void;
}

/** A parse input: raw parquet bytes, or a remote URL read via range requests. */
export type ParquetSource = Uint8Array | { url: string };

/** A decoded value, converted to a JSON-safe form python-side (see _json_safe). */
export type PreviewValue = string | number | boolean | null;

/**
 * Result of a value preview: the first N decoded values of a column chunk, or
 * a typed codec failure when the chunk's compression has no pure-python
 * fallback (lzo) so the values can't be decoded in-browser.
 */
export type PreviewResult =
    | { values: PreviewValue[]; total: number; truncated: boolean; error?: undefined }
    | { error: 'codec_unavailable'; codec: string };

/** Parses parquet sources into por-que dump JSON, plus follow-up queries. */
export interface ParquetParser {
    (source: ParquetSource, name: string): Promise<string>;
    /**
     * Tests a value against a column chunk's bloom filter in the most recently
     * parsed file. The value crosses as a string (BigInt-safe for INT64) and
     * is coerced python-side per the column's physical type. Rejects when no
     * file is loaded, the chunk has no bloom filter, or the type can't probe.
     */
    probeBloom(rowGroup: number, column: string, value: string): Promise<boolean>;
    /**
     * Decodes the first `maxValues` values of a column chunk in the most
     * recently parsed file. Codec-unavailable failures (lzo has no
     * pure-python fallback) come back as a typed result, not a rejection.
     */
    preview(rowGroup: number, column: string, maxValues: number): Promise<PreviewResult>;
    /**
     * Rehydrates a full dump into the current-file slot and attaches a
     * range-reading reader at `url`, so bloom/preview work on a JSON-loaded
     * dump without re-parsing the file (every offset is already in the dump).
     */
    bootFromDump(dumpJson: string, url: string): Promise<void>;
}

const PARSE_PY = `
import base64
import io
import json
import math
from por_que import AsyncHttpFile, ParquetFile
from por_que.exceptions import ParquetDataError
from por_que.statistics import BloomFilter
from por_que.util.async_adapter import ensure_async_reader

# Current-file slot: (ParquetFile, reader) of the most recent successful
# parse, kept alive so follow-up requests (bloom probes, value previews) can
# re-read the source without re-parsing. Replaced on every parse.
_current = None

async def _set_current(pf, reader):
    global _current
    if _current is not None:
        try:
            closing = _current[1].close()
            if closing is not None:  # AsyncHttpFile.close is async; BytesIO's isn't
                await closing
        except Exception:
            pass  # a dead old reader must not fail the new parse
    _current = (pf, reader)

def _wrap_progress(progress):
    # progress is a pyodide proxy of the JS callback; coerce the StrEnum phase
    # and ints before crossing back into JS.
    return lambda phase, done, total: progress(str(phase), int(done), int(total))

async def _dump(data, name, progress):
    reader = io.BytesIO(bytes(data.to_py()))
    pf = await ParquetFile.from_reader(reader, name, progress=_wrap_progress(progress))
    await _set_current(pf, reader)
    return pf.to_json()

async def _dump_url(url, progress):
    # AsyncHttpFile auto-selects hctef's pyfetch transport under emscripten
    # (browser fetch; node's global fetch under vitest) and reads via HTTP
    # range requests through a block cache, so only the byte ranges the
    # parser touches are downloaded. Opened without a context manager: the
    # reader outlives the parse in the current-file slot.
    f = await AsyncHttpFile(url).open()
    try:
        pf = await ParquetFile.from_reader(f, url, progress=_wrap_progress(progress))
    except BaseException:
        await f.close()
        raise
    await _set_current(pf, f)
    return pf.to_json()

async def _boot_from_dump(dump_json, url):
    # Purist path for a full structure dump loaded from JSON: the dump already
    # carries the entire parsed footer, so rehydrate it (from_json relinks the
    # schema) instead of re-reading the file's metadata. Attach a range-reading
    # reader at the recorded URL and park it in the current-file slot; bloom
    # probes and value previews then range-read only the spans they need -- no
    # footer parse, no whole-file download. Nothing the dump lacks is required.
    pf = ParquetFile.from_json(dump_json)
    f = await AsyncHttpFile(url).open()
    await _set_current(pf, f)

def _coerce_probe_value(value, physical_type):
    # Probe values always cross the JS boundary as strings; convert to the
    # python type BloomFilter hashing expects for the column. BYTE_ARRAY /
    # FIXED_LEN_BYTE_ARRAY take the string as-is (hashed as UTF-8); other
    # types (BOOLEAN, INT96) are rejected by might_contain itself.
    match physical_type.name:
        case 'INT32' | 'INT64':
            return int(value)
        case 'FLOAT' | 'DOUBLE':
            return float(value)
        case _:
            return value

async def _probe_bloom(row_group, column, value):
    if _current is None:
        raise RuntimeError('no parquet file is loaded in this worker')
    pf, reader = _current
    chunk = pf.metadata.row_groups[row_group].column_chunks[column]
    # The bytes path keeps a plain (sync) BytesIO in the slot; adapt it.
    bloom = await BloomFilter.from_reader(ensure_async_reader(reader), chunk)
    return bool(bloom.might_contain(_coerce_probe_value(value, chunk.type)))

_MAX_SAFE_INTEGER = 2**53 - 1  # Number.MAX_SAFE_INTEGER

def _json_safe(value):
    # Decoded values cross to JS as JSON: keep what survives intact, stringify
    # the rest. INT64 can exceed Number.MAX_SAFE_INTEGER; NaN/Inf aren't JSON;
    # raw BYTE_ARRAY (no STRING logical type) goes base64; logical renderings
    # the wheel already produced (datetime, Decimal, ...) read fine as str().
    match value:
        case None | bool() | str():
            return value
        case int():
            return value if -_MAX_SAFE_INTEGER <= value <= _MAX_SAFE_INTEGER else str(value)
        case float():
            return value if math.isfinite(value) else str(value)
        case bytes():
            return base64.b64encode(value).decode('ascii')
        case _:
            return str(value)

async def _preview(row_group, column, max_values):
    if _current is None:
        raise RuntimeError('no parquet file is loaded in this worker')
    pf, reader = _current
    chunk = next(
        (
            cc
            for cc in pf.column_chunks
            if cc.row_group == row_group and cc.path_in_schema == column
        ),
        None,
    )
    if chunk is None:
        raise KeyError(f'no column chunk {column!r} in row group {row_group}')
    values = []
    total = 0
    try:
        # ponytail: decodes the whole chunk, page-targeted decode when someone
        # loads a huge file
        async for value, _def_level, _rep_level in chunk.parse_all_data_pages(reader):
            total += 1
            if len(values) < max_values:
                values.append(_json_safe(value))
    except ParquetDataError as error:
        # compressors.py raises '<Codec> compression requires <pkg> package'
        # when the codec has no importable module and no pure-python fallback
        # -- lzo, so this is expected in-browser, not an error state.
        if 'requires' in str(error) and 'package' in str(error):
            return json.dumps({'error': 'codec_unavailable', 'codec': chunk.codec.name})
        raise
    return json.dumps({'values': values, 'total': total, 'truncated': total > len(values)})
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
    const detail = deps.onDetail ?? (() => {});
    const progress = deps.onProgress ?? (() => {});

    status('Loading Python runtime...');
    detail('downloading the pyodide runtime (~12 MB, cached by the browser)');
    const pyodide = await deps.loadPyodide(deps.indexURL ? { indexURL: deps.indexURL } : undefined);

    status('Installing dependencies...');
    // Compiled wheels bundled with the pyodide distribution. No aiohttp:
    // hctef.aio now imports without it and uses its pyfetch transport here.
    // messageCallback streams pyodide's per-package "Loading x" lines to the UI.
    await pyodide.loadPackage(['micropip', 'pydantic', 'zstandard', 'brotli'], {
        messageCallback: detail,
    });

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
    // The wheels are pinned PyPI releases staged as static assets by
    // scripts/fetch-wheels.py; bump versions there.
    for (const wheel of await deps.loadWheels()) {
        detail(`installing ${wheel.filename}`);
        const wheelPath = `/tmp/${wheel.filename}`;
        pyodide.FS.writeFile(wheelPath, wheel.bytes);
        await micropip.install.callKwargs(`emfs:${wheelPath}`, { deps: false });
    }

    detail('importing por_que');
    await pyodide.runPythonAsync(PARSE_PY);
    type PyProgress = (phase: string, done: number, total: number) => void;
    const dump = pyodide.globals.get('_dump') as (
        data: Uint8Array,
        name: string,
        progress: PyProgress
    ) => Promise<string>;
    const dumpUrl = pyodide.globals.get('_dump_url') as (
        url: string,
        progress: PyProgress
    ) => Promise<string>;
    const probeBloom = pyodide.globals.get('_probe_bloom') as (
        rowGroup: number,
        column: string,
        value: string
    ) => Promise<boolean>;
    const preview = pyodide.globals.get('_preview') as (
        rowGroup: number,
        column: string,
        maxValues: number
    ) => Promise<string>;
    const bootFromDump = pyodide.globals.get('_boot_from_dump') as (
        dumpJson: string,
        url: string
    ) => Promise<void>;

    // por-que's parse phases, in emission order, with human labels. The parse
    // is one process, so the status (modal title) stays put; each phase is
    // announced on the detail line with "step n of N", and the bar restarts
    // at that phase's own honest denominator. Unknown phases from a newer
    // por-que fall through to the raw phase string, uncounted.
    const PHASES = ['metadata-read', 'metadata-parse', 'column-chunks'] as const;
    const PHASE_LABELS: Record<string, string> = {
        'metadata-read': 'downloading metadata',
        'metadata-parse': 'parsing metadata',
        'column-chunks': 'scanning column chunks',
    };
    const formatSize = (bytes: number): string =>
        bytes < 1_000_000
            ? `${Math.round(bytes / 1000)} KB`
            : `${(bytes / 1_000_000).toFixed(1)} MB`;
    const phaseDetail = (phase: string, totalBytes: number): string => {
        const step = (PHASES as readonly string[]).indexOf(phase);
        let label = PHASE_LABELS[phase] ?? phase;
        if (phase === 'metadata-read') {
            label += ` (${formatSize(totalBytes)})`;
        }
        return step === -1 ? label : `${label} — step ${step + 1} of ${PHASES.length}`;
    };

    // Per-parse throttle: each Python->JS crossing is a proxy call plus a
    // postMessage, and parses can have thousands of row groups. Only forward
    // when the integer percentage changes within a phase. A phase change
    // updates the detail line and re-arms the throttle.
    const parseProgress = (): PyProgress => {
        let lastPhase: string | undefined;
        let lastPercent = -1;
        return (phase, done, total) => {
            if (total <= 0) {
                return;
            }
            if (phase !== lastPhase) {
                lastPhase = phase;
                lastPercent = -1;
                detail(phaseDetail(phase, total));
            }
            const percent = Math.floor((done / total) * 100);
            if (percent !== lastPercent) {
                lastPercent = percent;
                progress(done / total);
            }
        };
    };

    const parseBytes = async (bytes: Uint8Array, name: string): Promise<string> => {
        status('Parsing parquet...');
        detail(`${name} (${(bytes.length / 1_000_000).toFixed(1)} MB)`);
        return dump(bytes, name, parseProgress());
    };

    const parse = async (source: ParquetSource, name: string): Promise<string> => {
        if (source instanceof Uint8Array) {
            return parseBytes(source, name);
        }
        const { url } = source;
        status('Parsing parquet (HTTP range requests)...');
        detail(url);
        try {
            return await dumpUrl(url, parseProgress());
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
            detail(url);
            return parseBytes(await fetchBytes(url, progress), name);
        }
    };

    return Object.assign(parse, {
        probeBloom: (rowGroup: number, column: string, value: string) =>
            probeBloom(rowGroup, column, value),
        // Values cross the boundary as a JSON string: strings/numbers survive
        // pyodide proxying, but this keeps the conversion rules in one place
        // (python's _json_safe) and the payload copy-free.
        preview: async (rowGroup: number, column: string, maxValues: number) =>
            JSON.parse(await preview(rowGroup, column, maxValues)) as PreviewResult,
        bootFromDump: (dumpJson: string, url: string) => bootFromDump(dumpJson, url),
    });
}
