import { describe, it, expect, vi, afterEach } from 'vitest';
import { createParquetParser, type LoadPyodide } from '../src/js/worker/pyodide-parquet';

/**
 * Drives createParquetParser against a fake pyodide so the boot sequence,
 * status protocol, and URL/bytes routing (including the CORS fallback) are
 * covered without downloading a 12MB runtime.
 */
function fakePyodide() {
    const install = Object.assign(vi.fn().mockResolvedValue(undefined), {
        callKwargs: vi.fn().mockResolvedValue(undefined),
    });
    const dump = vi.fn().mockResolvedValue('{"dumped":true}');
    const dumpUrl = vi.fn().mockResolvedValue('{"dumped":"url"}');
    const probeBloom = vi.fn().mockResolvedValue(false);
    // The python side returns preview results as a JSON string.
    const preview = vi
        .fn()
        .mockResolvedValue(
            '{"values":[{"value":"Hello","def":1,"rep":0,"index":0}],"total":1,"nulls":0,"next":1}'
        );
    const globals = new Map<string, unknown>([
        ['_dump', dump],
        ['_dump_url', dumpUrl],
        ['_probe_bloom', probeBloom],
        ['_preview', preview],
    ]);
    return {
        loadPackage: vi.fn().mockResolvedValue(undefined),
        pyimport: vi.fn().mockReturnValue({ install }),
        FS: { writeFile: vi.fn() },
        runPythonAsync: vi.fn().mockResolvedValue(undefined),
        globals: { get: vi.fn((name: string) => globals.get(name)) },
        _install: install,
        _dump: dump,
        _dumpUrl: dumpUrl,
        _probeBloom: probeBloom,
        _preview: preview,
    };
}

const WHEELS = [
    { filename: 'hctef-9.9.9-py3-none-any.whl', bytes: new Uint8Array([4, 5]) },
    { filename: 'por_que-9.9.9-py3-none-any.whl', bytes: new Uint8Array([1, 2, 3]) },
];

async function boot(
    py: ReturnType<typeof fakePyodide>,
    statuses: string[] = [],
    fractions: number[] = [],
    details: string[] = []
) {
    return createParquetParser({
        loadPyodide: (() => Promise.resolve(py)) as unknown as LoadPyodide,
        loadWheels: () => Promise.resolve(WHEELS),
        onStatus: s => statuses.push(s),
        onProgress: f => fractions.push(f),
        onDetail: d => details.push(d),
    });
}

describe('createParquetParser (mocked pyodide)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('boots, installs the wheels deps-free, and parses bytes', async () => {
        const py = fakePyodide();
        const statuses: string[] = [];
        const parse = await boot(py, statuses);

        // No aiohttp: hctef.aio imports cleanly and uses pyfetch in pyodide.
        expect(py.loadPackage).toHaveBeenCalledWith(
            ['micropip', 'pydantic', 'zstandard', 'brotli'],
            { messageCallback: expect.any(Function) }
        );
        // Wheels installed by exact filename, without resolving deps.
        for (const wheel of WHEELS) {
            expect(py.FS.writeFile).toHaveBeenCalledWith(`/tmp/${wheel.filename}`, wheel.bytes);
            expect(py._install.callKwargs).toHaveBeenCalledWith(`emfs:/tmp/${wheel.filename}`, {
                deps: false,
            });
        }
        expect(statuses).toContain('Loading Python runtime...');
        expect(statuses).toContain('Installing por-que...');

        const input = new Uint8Array([0x50, 0x41, 0x52, 0x31]);
        const dump = await parse(input, 'x.parquet');
        expect(dump).toBe('{"dumped":true}');
        expect(py._dump).toHaveBeenCalledWith(input, 'x.parquet', expect.any(Function));
        expect(py._dumpUrl).not.toHaveBeenCalled();
        expect(statuses).toContain('Parsing parquet...');
    });

    it('forwards phase-tagged progress, deduplicated by integer percent per phase', async () => {
        const py = fakePyodide();
        const statuses: string[] = [];
        const fractions: number[] = [];
        const details: string[] = [];
        const parse = await boot(py, statuses, fractions, details);
        await parse(new Uint8Array([1]), 'x.parquet');
        const statusCount = statuses.length;

        const onProgress = py._dump.mock.calls[0]?.[2] as (
            phase: string,
            done: number,
            total: number
        ) => void;
        onProgress('metadata-read', 0, 100);
        onProgress('metadata-read', 0, 100); // same phase, same percent: dropped
        onProgress('metadata-read', 50, 100);
        onProgress('metadata-read', 100, 100);
        onProgress('metadata-parse', 0, 4); // new phase: 0% re-emitted
        onProgress('metadata-parse', 2, 4);
        onProgress('metadata-parse', 4, 4);
        onProgress('column-chunks', 0, 8);
        onProgress('column-chunks', 8, 8);
        onProgress('column-chunks', 1, 0); // zero total: ignored
        expect(fractions).toEqual([0, 0.5, 1, 0, 0.5, 1, 0, 1]);

        // The modal title (status) never changes during the parse: phases are
        // announced on the detail line, with overall step position.
        expect(statuses.length).toBe(statusCount);
        expect(details.slice(-3)).toEqual([
            'downloading metadata (0 KB) — step 1 of 3',
            'parsing metadata — step 2 of 3',
            'scanning column chunks — step 3 of 3',
        ]);
    });

    it('routes bloom probes to the python probe with string values', async () => {
        const py = fakePyodide();
        py._probeBloom.mockResolvedValueOnce(true);
        const parse = await boot(py);

        // The value stays a string across the boundary (BigInt-safe for INT64);
        // the python side coerces it per the column's physical type.
        await expect(parse.probeBloom(2, 'id', '9007199254740993')).resolves.toBe(true);
        expect(py._probeBloom).toHaveBeenCalledWith(2, 'id', '9007199254740993');
    });

    it('parses preview JSON off the python side, typed either way', async () => {
        const py = fakePyodide();
        const parse = await boot(py);

        // Success payload: the JSON string becomes a typed result object, and
        // the window coordinates (offset/limit/skipNulls) pass straight through.
        await expect(parse.preview(0, 'String', 0, 0, 100, false)).resolves.toEqual({
            values: [{ value: 'Hello', def: 1, rep: 0, index: 0 }],
            total: 1,
            nulls: 0,
            next: 1,
        });
        expect(py._preview).toHaveBeenCalledWith(0, 'String', 0, 0, 100, false);

        // Codec failure is a typed RESULT (lzo has no pure-python fallback),
        // never a rejection: the UI renders a friendly note, not an error.
        py._preview.mockResolvedValueOnce('{"error":"codec_unavailable","codec":"LZO"}');
        await expect(parse.preview(1, 'col', 2, 0, 100, true)).resolves.toEqual({
            error: 'codec_unavailable',
            codec: 'LZO',
        });
    });

    it('routes URL sources through the range-request path', async () => {
        const py = fakePyodide();
        const statuses: string[] = [];
        const parse = await boot(py, statuses);

        const dump = await parse({ url: 'https://example.com/f.parquet' }, 'f.parquet');
        expect(dump).toBe('{"dumped":"url"}');
        expect(py._dumpUrl).toHaveBeenCalledWith(
            'https://example.com/f.parquet',
            expect.any(Function)
        );
        expect(py._dump).not.toHaveBeenCalled();
        expect(statuses).toContain('Parsing parquet (HTTP range requests)...');
    });

    it('falls back to a whole-file download on HctefNetworkError', async () => {
        const py = fakePyodide();
        py._dumpUrl.mockRejectedValue(
            new Error('hctef.exceptions.HctefNetworkError: no Content-Range for you')
        );
        const body = new Uint8Array([0x50, 0x41, 0x52, 0x31]);
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            headers: new Headers(),
            body: null,
            arrayBuffer: () => Promise.resolve(body.buffer),
        });
        vi.stubGlobal('fetch', fetchMock);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const statuses: string[] = [];
        const parse = await boot(py, statuses);
        const dump = await parse({ url: 'https://example.com/f.parquet' }, 'f.parquet');

        expect(dump).toBe('{"dumped":true}');
        expect(fetchMock).toHaveBeenCalledWith('https://example.com/f.parquet');
        expect(py._dump).toHaveBeenCalledWith(body, 'f.parquet', expect.any(Function));
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('Range requests unavailable'),
            expect.anything()
        );
        expect(statuses).toContain('Range requests unavailable; downloading whole file...');
    });

    it('propagates non-network errors from the URL path without fallback', async () => {
        const py = fakePyodide();
        py._dumpUrl.mockRejectedValue(new Error('ParquetCorruptedError: bad magic'));
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        const parse = await boot(py);
        await expect(parse({ url: 'https://example.com/f.parquet' }, 'f.parquet')).rejects.toThrow(
            'bad magic'
        );
        expect(fetchMock).not.toHaveBeenCalled();
        expect(py._dump).not.toHaveBeenCalled();
    });
});
