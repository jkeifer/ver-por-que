import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { loadPyodide } from 'pyodide';
import {
    createParquetParser,
    type LoadPyodide,
    type ParquetParser,
    type WheelAsset,
} from '../src/js/worker/pyodide-parquet';
import { validateFile } from '../src/generated/validate';

/**
 * End-to-end: boot real pyodide, install the locally-built por-que and hctef
 * wheels, parse a real parquet file (from bytes AND from a URL via HTTP range
 * requests), and assert the dumps pass the same ajv validator the app uses.
 * Skipped (with a message) when the wheels are absent -- run `npm run wheel`
 * first, which CI does.
 *
 * alltypes_plain.snappy.parquet is deliberate: it proves a SNAPPY file dumps
 * AND that its values decode via por-que's pure-python snappy fallback.
 */
const vendorDir = fileURLToPath(new URL('../static/vendor/', import.meta.url));
const manifestPath = `${vendorDir}manifest.json`;
const hasWheel = existsSync(manifestPath);

const fixturePath = (name: string): string =>
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

// Pinned to the same apache/parquet-testing ref as the python test fixtures.
const PARQUET_TESTING_REF = '1a2a75127be06fc0123f03ebd36c966f7beda27d';
const PARQUET_URL =
    `https://raw.githubusercontent.com/apache/parquet-testing/` +
    `${PARQUET_TESTING_REF}/data/alltypes_plain.snappy.parquet`;

function loadWheels(): WheelAsset[] {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        wheel: string;
        hctef: string;
    };
    return [manifest.hctef, manifest.wheel].map(filename => ({
        filename,
        bytes: new Uint8Array(readFileSync(`${vendorDir}${filename}`)),
    }));
}

interface FixtureServer {
    url: string;
    /** Range header of every request received, null when absent. */
    ranges: (string | null)[];
    close: () => Promise<void>;
}

/**
 * Serves `body` over local HTTP. With `supportRanges`, bounded Range requests
 * get a proper 206 + Content-Range; without it, every request gets the whole
 * body as a plain 200 (a server -- or CORS setup -- that defeats range reads).
 */
function serveFixture(body: Uint8Array, supportRanges: boolean): Promise<FixtureServer> {
    const ranges: (string | null)[] = [];
    const server = createServer((req, res) => {
        const range = req.headers.range ?? null;
        ranges.push(range);
        const match = supportRanges && range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
        if (match) {
            const start = Number(match[1]);
            const end = Math.min(Number(match[2]), body.length - 1);
            const chunk = body.subarray(start, end + 1);
            res.writeHead(206, {
                'Content-Type': 'application/octet-stream',
                'Content-Range': `bytes ${start}-${end}/${body.length}`,
                'Content-Length': chunk.length,
            });
            res.end(Buffer.from(chunk));
        } else {
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': body.length,
            });
            res.end(Buffer.from(body));
        }
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolve({
                url: `http://127.0.0.1:${port}/alltypes_plain.snappy.parquet`,
                ranges,
                close: () => new Promise(done => server.close(() => done())),
            });
        });
    });
}

function expectValidDump(dump: string): void {
    const parsed: unknown = JSON.parse(dump);
    const ok = validateFile(parsed);
    if (!ok) {
        throw new Error(
            `dump failed schema validation: ${JSON.stringify(validateFile.errors?.slice(0, 3))}`
        );
    }
    expect(ok).toBe(true);
    expect((parsed as { column_chunks?: unknown }).column_chunks).toBeDefined();
}

describe.skipIf(!hasWheel)('createParquetParser (real pyodide)', () => {
    if (!hasWheel) {
        it('skipped: run `npm run wheel` to build the por-que/hctef wheels first', () => {});
        return;
    }

    let parse: ParquetParser;
    let data: Uint8Array;
    const statuses: string[] = [];
    const fractions: number[] = [];
    const details: string[] = [];

    // Boot once (~12MB runtime) and reuse the parser across tests, like the app.
    beforeAll(async () => {
        // Under vitest, pyodide can't auto-locate its own dist files (the
        // transform breaks its __dirname detection); point it at the package.
        const indexURL = fileURLToPath(new URL('../node_modules/pyodide/', import.meta.url));
        parse = await createParquetParser({
            loadPyodide: loadPyodide as unknown as LoadPyodide,
            indexURL,
            loadWheels: () => Promise.resolve(loadWheels()),
            onStatus: s => statuses.push(s),
            onProgress: f => fractions.push(f),
            onDetail: d => details.push(d),
        });
        data = new Uint8Array(await (await fetch(PARQUET_URL)).arrayBuffer());
    }, 180_000);

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('parses raw bytes into a schema-valid dump, reporting phased progress', async () => {
        const statusStart = statuses.length;
        const fractionStart = fractions.length;
        const detailStart = details.length;

        const dump = await parse(data, 'alltypes_plain.snappy.parquet');
        expectValidDump(dump);

        // One title for the whole parse; the real por-que wheel drives all
        // three progress phases in order on the detail line.
        expect(statuses.slice(statusStart)).toEqual(['Parsing parquet...']);
        const steps = details.slice(detailStart).filter(d => d.includes('step '));
        expect(steps[0]).toMatch(/^downloading metadata \(\d+ KB\) — step 1 of 3$/);
        expect(steps.slice(1)).toEqual([
            'parsing metadata — step 2 of 3',
            'scanning column chunks — step 3 of 3',
        ]);
        const seen = fractions.slice(fractionStart);
        // Each phase contributes at least its 0 and its 1 (throttle permitting).
        expect(seen.length).toBeGreaterThanOrEqual(6);
        expect(seen[0]).toBe(0);
        expect(seen[seen.length - 1]).toBe(1);
        expect(seen.every(f => f >= 0 && f <= 1)).toBe(true);
    }, 60_000);

    it('parses a URL via HTTP range requests, never fetching the whole body', async () => {
        const server = await serveFixture(data, true);
        try {
            const dump = await parse({ url: server.url }, server.url);
            expectValidDump(dump);

            // At least the 1-byte probe plus one block fetch...
            expect(server.ranges.length).toBeGreaterThanOrEqual(2);
            expect(server.ranges[0]).toBe('bytes=0-0');
            // ...and every request was a bounded range request: the file was
            // never downloaded in one whole-body GET.
            expect(server.ranges.every(r => r !== null)).toBe(true);
        } finally {
            await server.close();
        }
    }, 60_000);

    it('probes bloom filters in the current-file slot after a bytes parse', async () => {
        // Local fixture with a real split-block bloom filter (offset AND
        // length recorded) on its one String column, values 'Hello'..'today'.
        const bloomFile = new Uint8Array(
            readFileSync(fixturePath('data_index_bloom_encoding_with_length.parquet'))
        );
        expectValidDump(await parse(bloomFile, 'data_index_bloom_encoding_with_length.parquet'));

        // The parse populated the worker-side current-file slot; probes hit it.
        await expect(parse.probeBloom(0, 'String', 'Hello')).resolves.toBe(true);
        await expect(parse.probeBloom(0, 'String', 'zzzzzz-not-here')).resolves.toBe(false);

        // Unknown columns and unloadable filters reject rather than guess.
        await expect(parse.probeBloom(0, 'nope', 'x')).rejects.toThrow(/KeyError|nope/);
    });

    it('previews decoded values from the current-file slot', async () => {
        const bloomFile = new Uint8Array(
            readFileSync(fixturePath('data_index_bloom_encoding_with_length.parquet'))
        );
        expectValidDump(await parse(bloomFile, 'data_index_bloom_encoding_with_length.parquet'));

        // Exact first values of the one String column (UNCOMPRESSED, PLAIN).
        await expect(parse.preview(0, 'String', 3)).resolves.toEqual({
            values: ['Hello', 'This is', 'a'],
            total: 14,
            truncated: true,
        });

        // maxValues past the end: everything, untruncated.
        const all = await parse.preview(0, 'String', 100);
        if (all.error !== undefined) {
            throw new Error(`unexpected codec failure: ${all.codec}`);
        }
        expect(all).toMatchObject({ total: 14, truncated: false });
        expect(all.values).toHaveLength(14);
        expect(all.values[13]).toBe('dog');

        // Unknown columns reject rather than guess.
        await expect(parse.preview(0, 'nope', 3)).rejects.toThrow(/KeyError|nope/);
    });

    it('decodes snappy chunks via por-que pure-python fallback', async () => {
        expectValidDump(await parse(data, 'alltypes_plain.snappy.parquet'));

        // por-que ships a pure-python snappy fallback used when the
        // python-snappy C extension is absent (as under pyodide), so SNAPPY
        // values now decode in-browser instead of returning codec_unavailable.
        await expect(parse.preview(0, 'id', 5)).resolves.toEqual({
            values: [6, 7],
            total: 2,
            truncated: false,
        });
    });

    it('falls back to a whole-file download when ranges are unsupported', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const server = await serveFixture(data, false);
        try {
            const dump = await parse({ url: server.url }, server.url);
            expectValidDump(dump);

            // The probe got a 200 without Content-Range, so hctef bailed and
            // the parser downloaded the whole file (a range-less request).
            expect(server.ranges.some(r => r === null)).toBe(true);
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('Range requests unavailable'),
                expect.anything()
            );
        } finally {
            await server.close();
        }
    }, 60_000);
});
