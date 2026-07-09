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
 * A decoded value with its Dremel definition and repetition levels, plus its
 * absolute index within the page — which the window can't infer positionally
 * once null-skipping makes the window sparse.
 */
export interface PreviewEntry {
    value: PreviewValue;
    def: number;
    rep: number;
    index: number;
    /** The raw physical value, present only when it differs from the displayed
     *  (logically converted) `value` — i.e. logical types. It's what the bloom
     *  probe hashes, so the UI offers it for copy. */
    physical?: PreviewValue;
}

/**
 * Result of a value preview: one window of a data page's decoded values
 * (`values`), the page's true value count (`total`) and null count (`nulls`),
 * and `next` — the value index where the following window begins (one past the
 * span this window consumed), so the UI can paginate and label the range. Or a
 * typed codec failure when the chunk's compression has no pure-python fallback
 * (lzo) so the values can't be decoded in-browser.
 */
export type PreviewResult =
    | { values: PreviewEntry[]; total: number; nulls: number; next: number; error?: undefined }
    | { error: 'codec_unavailable'; codec: string };

/** One of the eight bits a probe checks: which word (0-7), which bit within it
 *  (0-31), and whether the filter has it set. All eight set ⟹ "might contain". */
export interface BloomProbeBit {
    word: number;
    bit: number;
    set: boolean;
}

/**
 * A bloom-filter probe with its full split-block derivation: the value's 64-bit
 * hash (hex), the single 256-bit block it selects (of `numBlocks`), that block's
 * 32 bytes (base64), and the eight bits checked. `mightContain` is true iff
 * every bit is set; a single unset bit is exact proof of absence.
 */
export interface BloomProbeResult {
    mightContain: boolean;
    hash: string;
    blockIndex: number;
    numBlocks: number;
    block: string;
    bits: BloomProbeBit[];
}

/** One dictionary entry: a distinct value and its position in the dictionary. */
export interface DictionaryEntry {
    value: PreviewValue;
    index: number;
}

/**
 * Result of a dictionary preview: one window of a chunk's distinct values
 * (`values`), the dictionary's total entry count (`total`), and `next` (one
 * past this window). A dictionary has no def/rep levels and no nulls, so it
 * carries neither. Or a typed codec failure, like PreviewResult.
 */
export type DictionaryPreviewResult =
    | { values: DictionaryEntry[]; total: number; next: number; error?: undefined }
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
    probeBloom(rowGroup: number, column: string, value: string): Promise<BloomProbeResult>;
    /**
     * Decodes a window of data page `pageIndex` in column chunk (`rowGroup`,
     * `column`) of the most recently parsed file, starting at value index
     * `offset`. With `skipNulls`, the window is up to `limit` NON-null values
     * (scanning as far through the page as needed); otherwise it's the
     * `[offset, offset+limit)` slice. The page is decoded once and cached, so
     * paging never re-decodes; the result carries `total`/`nulls`/`next` for the
     * pager. Codec-unavailable failures (lzo has no pure-python fallback) come
     * back as a typed result, not a rejection.
     */
    preview(
        rowGroup: number,
        column: string,
        pageIndex: number,
        offset: number,
        limit: number,
        skipNulls: boolean
    ): Promise<PreviewResult>;
    /**
     * Decodes a `[offset, offset+limit)` window of the dictionary page in column
     * chunk (`rowGroup`, `column`) — the chunk's distinct values. Decoded once
     * and cached, so paging never re-decodes. Codec-unavailable failures come
     * back as a typed result, not a rejection.
     */
    previewDictionary(
        rowGroup: number,
        column: string,
        offset: number,
        limit: number
    ): Promise<DictionaryPreviewResult>;
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

# Decoded-page cache for value previews: (row_group, column, page_index, values,
# nulls). A data page is decoded once and pagination slices windows out of it, so
# paging never re-decodes. Holds ONE page; a new page or a new file evicts it.
# ponytail: one page resident (can be ~1M values). If first-open latency on huge
# pages bites, grow the cache lazily as the user pages instead of decoding whole.
_preview_cache = None

# Decoded-dictionary cache for dictionary-page previews: (row_group, column,
# values). A chunk's dictionary is decoded once and pagination slices it, same
# decode-once/slice-many contract as _preview_cache. Holds ONE dictionary.
_dict_cache = None

async def _set_current(pf, reader):
    global _current, _preview_cache, _dict_cache
    _preview_cache = None
    _dict_cache = None
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

def _is_binary_leaf(column_chunk):
    # A "binary column": BYTE_ARRAY / FIXED_LEN_BYTE_ARRAY that is NOT a string
    # leaf (geometry WKB, UUID, raw binary). column_chunk is a ColumnChunk
    # (metadata), exposing .type and .schema_element. Mirrors isStringLeaf in
    # src/business/stat-values.ts: get_logical_type() folds converted UTF8->STRING
    # and ENUM->ENUM, so a single STRING/ENUM check covers the JS rule's
    # logical-and-converted branches. String columns hash their typed text as
    # UTF-8; binary columns take base64 of the raw bytes.
    if column_chunk.type.name not in ('BYTE_ARRAY', 'FIXED_LEN_BYTE_ARRAY'):
        return False
    lt = column_chunk.schema_element.get_logical_type()
    return not (lt is not None and lt.logical_type.name in ('STRING', 'ENUM'))

def _coerce_probe_value(value, chunk):
    # Probe values always cross the JS boundary as strings; convert to the
    # python type BloomFilter hashing expects for the column. String BYTE_ARRAY /
    # FIXED_LEN_BYTE_ARRAY take the string as-is (hashed as UTF-8); binary ones
    # carry base64 of the raw bytes, decoded back to bytes here so _plain_encode
    # hashes the raw bytes. Other types (BOOLEAN, INT96) are rejected by
    # might_contain itself.
    match chunk.type.name:
        case 'INT32' | 'INT64':
            return int(value)
        case 'FLOAT' | 'DOUBLE':
            return float(value)
        case 'BYTE_ARRAY' | 'FIXED_LEN_BYTE_ARRAY' if _is_binary_leaf(chunk):
            # Base64 decode failure raises -> surfaces as "Probe failed"; the UI
            # validates base64 first, so this is the belt-and-suspenders path.
            return base64.b64decode(value)
        case _:
            return value

async def _probe_bloom(row_group, column, value):
    # Return the full split-block derivation, not just the yes/no: the value's
    # hash, the single block it selects, that block's 32 bytes, and the eight
    # bits checked. mightContain is true iff all eight are set; any unset bit is
    # exact proof of absence. Mirrors BloomFilter._block_check step for step.
    from por_que.util.xxhash import xxh64
    from por_que.statistics import SBBF_SALT
    if _current is None:
        raise RuntimeError('no parquet file is loaded in this worker')
    pf, reader = _current
    chunk = pf.metadata.row_groups[row_group].column_chunks[column]
    # The bytes path keeps a plain (sync) BytesIO in the slot; adapt it.
    bloom = await BloomFilter.from_reader(ensure_async_reader(reader), chunk)
    # _plain_encode raises for unqueryable physical types (INT96/BOOLEAN), same
    # as might_contain would -- surfaces as a probe failure, not a bad result.
    hash_ = xxh64(bloom._plain_encode(_coerce_probe_value(value, chunk)))
    num_blocks = bloom.num_blocks
    block_index = ((hash_ >> 32) * num_blocks) >> 32
    base = block_index * 32  # 256-bit block = 8 words * 4 bytes
    block = bytes(bloom.bitset[base:base + 32])
    low = hash_ & 0xffffffff
    bits = []
    might = True
    for i in range(8):
        word = int.from_bytes(block[i * 4:i * 4 + 4], 'little')
        bit = ((low * SBBF_SALT[i]) & 0xffffffff) >> 27  # 0..31
        is_set = bool((word >> bit) & 1)
        might = might and is_set
        bits.append({'word': i, 'bit': bit, 'set': is_set})
    return json.dumps({
        'mightContain': might,
        'hash': format(hash_, '016x'),
        'blockIndex': block_index,
        'numBlocks': num_blocks,
        'block': base64.b64encode(block).decode('ascii'),
        'bits': bits,
    })

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

def _find_data_chunk(row_group, column):
    # The physical column-chunk object (it carries the page parsers), matched by
    # (row_group, path). Raises if no file is loaded or the column is absent.
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
    return reader, chunk

async def _preview(row_group, column, page_index, offset, limit, skip_nulls):
    # Decode-once, slice-many: the first request for a page decodes it whole and
    # caches it; pagination re-slices the cache. Only the requested window (plus
    # the page total and null count) crosses to JS -- a pathological page (~1M
    # values) never ships or renders in full.
    global _preview_cache
    if _preview_cache is not None and _preview_cache[:3] == (row_group, column, page_index):
        _, _, _, values, nulls = _preview_cache
    else:
        reader, chunk = _find_data_chunk(row_group, column)
        se = chunk.metadata.schema_element
        # Binary (non-string byte) columns hash base64 of the raw bytes, so the
        # UI copies the base64 physical for the probe. Computed once per page.
        is_binary = _is_binary_leaf(chunk.metadata)
        values = []
        nulls = 0
        try:
            # Decode physical values once (logical conversion skipped), then apply
            # the same physical_to_logical_type the data-page parser uses -- so a
            # single pass yields both the display value and the raw physical value
            # the bloom probe hashes. They differ only for numeric-backed logical
            # types (temporal, decimal, ...), where 'physical' is carried so the
            # user can copy the probe-ready value; byte-array strings decode to
            # themselves -- exactly what you'd type -- so they get no button.
            for raw, def_level, rep_level in await chunk.parse_data_page(
                page_index, reader, excluded_logical_columns=[se.full_path]
            ):
                logical = se.physical_to_logical_type(raw) if raw is not None else None
                entry = {'value': _json_safe(logical), 'def': def_level, 'rep': rep_level}
                # Attach the probe-ready physical when it differs from the display:
                # numeric-backed logical types (temporal/decimal) carry the int;
                # binary byte columns carry base64 of the raw bytes (UUID shows hex
                # -> base64 attached; geometry/plain-binary already display base64,
                # so _json_safe(raw) == value and nothing is attached). String
                # columns are excluded by is_binary, so their bytes never leak as a
                # misleading base64 overlay.
                physical = None
                if isinstance(raw, (int, float)) and not isinstance(raw, bool):
                    physical = _json_safe(raw)
                elif is_binary and isinstance(raw, bytes):
                    physical = _json_safe(raw)
                if physical is not None and physical != entry['value']:
                    entry['physical'] = physical
                values.append(entry)
                if logical is None:
                    nulls += 1
        except ParquetDataError as error:
            # compressors.py raises '<Codec> compression requires <pkg> package'
            # when the codec has no importable module and no pure-python fallback
            # -- lzo, so this is expected in-browser, not an error state.
            if 'requires' in str(error) and 'package' in str(error):
                return json.dumps({'error': 'codec_unavailable', 'codec': chunk.codec.name})
            raise
        _preview_cache = (row_group, column, page_index, values, nulls)
    total = len(values)
    window = []
    if skip_nulls:
        # Collect up to "limit" NON-null values, scanning as far through the page
        # as that takes, then absorb any trailing null run so the next window
        # begins on a real value. next_index is the span consumed: with only a
        # handful of non-nulls in a huge page, the window is small but the range
        # (offset..next_index) spans everything it scanned past.
        i = offset
        while i < total and len(window) < limit:
            v = values[i]
            if v['value'] is not None:
                window.append({**v, 'index': i})
            i += 1
        while i < total and values[i]['value'] is None:
            i += 1
        next_index = i
    else:
        next_index = min(offset + limit, total)
        window = [{**values[i], 'index': i} for i in range(offset, next_index)]
    return json.dumps({'values': window, 'total': total, 'nulls': nulls, 'next': next_index})

async def _preview_dictionary(row_group, column, offset, limit):
    # A dictionary page is a flat list of the chunk's distinct values (no
    # def/rep levels, no nulls), so paging is plain arithmetic over the decoded
    # list. Decode-once/slice-many like _preview.
    global _dict_cache
    if _dict_cache is not None and _dict_cache[:2] == (row_group, column):
        _, _, values = _dict_cache
    else:
        reader, chunk = _find_data_chunk(row_group, column)
        try:
            # _parse_dictionary (unlike parse_data_page) doesn't adapt the
            # reader itself; the bytes path keeps a sync BytesIO in the slot.
            decoded = await chunk._parse_dictionary(ensure_async_reader(reader))
        except ParquetDataError as error:
            # Same codec-unavailable (lzo) contract as _preview: a typed result,
            # not a raise.
            if 'requires' in str(error) and 'package' in str(error):
                return json.dumps({'error': 'codec_unavailable', 'codec': chunk.codec.name})
            raise
        # _parse_dictionary returns raw physical values (BYTE_ARRAY -> bytes);
        # apply the same logical rendering the data-page parser does, so a UTF8
        # column reads as text (not base64) and matches the value preview.
        se = chunk.metadata.schema_element
        values = [_json_safe(se.physical_to_logical_type(v) if v is not None else v) for v in decoded]
        _dict_cache = (row_group, column, values)
    total = len(values)
    next_index = min(offset + limit, total)
    window = [{'value': values[i], 'index': i} for i in range(offset, next_index)]
    return json.dumps({'values': window, 'total': total, 'next': next_index})
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
    ) => Promise<string>;
    const preview = pyodide.globals.get('_preview') as (
        rowGroup: number,
        column: string,
        pageIndex: number,
        offset: number,
        limit: number,
        skipNulls: boolean
    ) => Promise<string>;
    const previewDictionary = pyodide.globals.get('_preview_dictionary') as (
        rowGroup: number,
        column: string,
        offset: number,
        limit: number
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
        probeBloom: async (rowGroup: number, column: string, value: string) =>
            JSON.parse(await probeBloom(rowGroup, column, value)) as BloomProbeResult,
        // Values cross the boundary as a JSON string: strings/numbers survive
        // pyodide proxying, but this keeps the conversion rules in one place
        // (python's _json_safe) and the payload copy-free.
        preview: async (
            rowGroup: number,
            column: string,
            pageIndex: number,
            offset: number,
            limit: number,
            skipNulls: boolean
        ) =>
            JSON.parse(
                await preview(rowGroup, column, pageIndex, offset, limit, skipNulls)
            ) as PreviewResult,
        previewDictionary: async (
            rowGroup: number,
            column: string,
            offset: number,
            limit: number
        ) =>
            JSON.parse(
                await previewDictionary(rowGroup, column, offset, limit)
            ) as DictionaryPreviewResult,
        bootFromDump: (dumpJson: string, url: string) => bootFromDump(dumpJson, url),
    });
}
