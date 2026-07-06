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
    const globals = new Map<string, unknown>([
        ['_dump', dump],
        ['_dump_url', dumpUrl],
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
    };
}

const WHEELS = [
    { filename: 'hctef-9.9.9-py3-none-any.whl', bytes: new Uint8Array([4, 5]) },
    { filename: 'por_que-9.9.9-py3-none-any.whl', bytes: new Uint8Array([1, 2, 3]) },
];

async function boot(py: ReturnType<typeof fakePyodide>, statuses: string[] = []) {
    return createParquetParser({
        loadPyodide: (() => Promise.resolve(py)) as unknown as LoadPyodide,
        loadWheels: () => Promise.resolve(WHEELS),
        onStatus: s => statuses.push(s),
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
        expect(py.loadPackage).toHaveBeenCalledWith([
            'micropip',
            'pydantic',
            'zstandard',
            'brotli',
        ]);
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
        expect(py._dump).toHaveBeenCalledWith(input, 'x.parquet');
        expect(py._dumpUrl).not.toHaveBeenCalled();
        expect(statuses).toContain('Parsing parquet...');
    });

    it('routes URL sources through the range-request path', async () => {
        const py = fakePyodide();
        const statuses: string[] = [];
        const parse = await boot(py, statuses);

        const dump = await parse({ url: 'https://example.com/f.parquet' }, 'f.parquet');
        expect(dump).toBe('{"dumped":"url"}');
        expect(py._dumpUrl).toHaveBeenCalledWith('https://example.com/f.parquet');
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
            arrayBuffer: () => Promise.resolve(body.buffer),
        });
        vi.stubGlobal('fetch', fetchMock);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const statuses: string[] = [];
        const parse = await boot(py, statuses);
        const dump = await parse({ url: 'https://example.com/f.parquet' }, 'f.parquet');

        expect(dump).toBe('{"dumped":true}');
        expect(fetchMock).toHaveBeenCalledWith('https://example.com/f.parquet');
        expect(py._dump).toHaveBeenCalledWith(body, 'f.parquet');
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
