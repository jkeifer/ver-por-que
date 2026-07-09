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

// Committed from apache/parquet-testing @ 1a2a75127be06fc0123f03ebd36c966f7beda27d
// (data/alltypes_plain.snappy.parquet), the same ref the python test fixtures pin.
const ALLTYPES_FIXTURE = 'alltypes_plain.snappy.parquet';

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
        data = new Uint8Array(readFileSync(fixturePath(ALLTYPES_FIXTURE)));
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
        // The probe returns the full split-block derivation; .mightContain is
        // the verdict, and a "maybe" must have all eight checked bits set.
        const hit = await parse.probeBloom(0, 'String', 'Hello');
        expect(hit.mightContain).toBe(true);
        expect(hit.bits).toHaveLength(8);
        expect(hit.bits.every(b => b.set)).toBe(true);
        expect(hit.blockIndex).toBeLessThan(hit.numBlocks);
        const miss = await parse.probeBloom(0, 'String', 'zzzzzz-not-here');
        expect(miss.mightContain).toBe(false);
        expect(miss.bits.some(b => !b.set)).toBe(true); // an unset bit proves absence

        // Unknown columns and unloadable filters reject rather than guess.
        await expect(parse.probeBloom(0, 'nope', 'x')).rejects.toThrow(/KeyError|nope/);
    });

    it('reduces a whole bloom filter to a density strip', async () => {
        // Every column of this fixture carries a real, populated bloom filter,
        // so its density is neither empty (0) nor saturated (1).
        const bytes = new Uint8Array(readFileSync(fixturePath('weather_station_daily.parquet')));
        expectValidDump(await parse(bytes, 'weather_station_daily.parquet'));

        const density = await parse.bloomDensity(0, 'temperature');
        expect(density.numBlocks).toBeGreaterThan(0);
        expect(density.fill).toBeGreaterThan(0);
        expect(density.fill).toBeLessThan(1);
        expect(density.buckets.length).toBeGreaterThan(0);
        expect(density.buckets.every(b => b >= 0 && b <= 1)).toBe(true);
        // A contiguous run of blocks' raw bytes comes back on demand (base64) in
        // one call, so the UI can render a window of bit-grids at any filter size
        // without shipping the whole bitset (this fixture has 8 blocks).
        const blocks = await parse.bloomBlocks(0, 'temperature', 0, 4);
        expect(Buffer.from(blocks, 'base64').length).toBe(4 * 32);
    });

    it('prefetches every bloom filter to warm the reader block cache', async () => {
        // 13 row groups x 10 columns, each with a populated bloom filter, so a
        // prefetch warms 130 filters. Returns how many it read.
        const bytes = new Uint8Array(readFileSync(fixturePath('weather_station_daily.parquet')));
        expectValidDump(await parse(bytes, 'weather_station_daily.parquet'));
        const warmed = await parse.prefetchBlooms();
        expect(warmed).toBe(130);
    });

    it('previews a data page of decoded values from the current-file slot', async () => {
        const bloomFile = new Uint8Array(
            readFileSync(fixturePath('data_index_bloom_encoding_with_length.parquet'))
        );
        expectValidDump(await parse(bloomFile, 'data_index_bloom_encoding_with_length.parquet'));

        // The one String column (UNCOMPRESSED, PLAIN) has a single data page,
        // so page 0 is the whole column: all 14 values. A window wide enough to
        // hold them returns the lot, and reports the page's true total.
        const page = await parse.preview(0, 'String', 0, 0, 100, false);
        if (page.error !== undefined) {
            throw new Error(`unexpected codec failure: ${page.codec}`);
        }
        expect(page.total).toBe(14);
        expect(page.nulls).toBe(0);
        expect(page.values).toHaveLength(14);
        expect(page.values.slice(0, 3).map(v => v.value)).toEqual(['Hello', 'This is', 'a']);
        expect(page.values[13]!.value).toBe('dog');
        // A string column's value IS what you'd probe, so no physical overlay
        // (the raw bytes are not offered as a misleading base64 copy).
        expect(page.values.every(v => v.physical === undefined)).toBe(true);
        // Every value carries its Dremel definition + repetition levels.
        expect(page.values.every(v => typeof v.def === 'number' && typeof v.rep === 'number')).toBe(
            true
        );

        // Pagination: a bounded window returns only its slice but still reports
        // the whole page's total; a later offset resumes exactly where the full
        // page leaves off (served from the worker's decoded-page cache, not a
        // re-decode). Windows match the corresponding slice of the full page.
        const first = await parse.preview(0, 'String', 0, 0, 5, false);
        const rest = await parse.preview(0, 'String', 0, 10, 5, false);
        if (first.error !== undefined || rest.error !== undefined) {
            throw new Error('unexpected codec failure while paginating');
        }
        expect(first.total).toBe(14);
        expect(first.values.map(v => v.value)).toEqual(page.values.slice(0, 5).map(v => v.value));
        expect(rest.values).toHaveLength(4); // offset 10, only 10..13 remain
        expect(rest.values.map(v => v.value)).toEqual(page.values.slice(10, 14).map(v => v.value));

        // Unknown columns reject rather than guess.
        await expect(parse.preview(0, 'nope', 0, 0, 100, false)).rejects.toThrow(/KeyError|nope/);
    });

    it('skips nulls by scanning the page, with sparse indices and a spanning range', async () => {
        // Column 'n' is [1, null, null, 2, null, null]: non-null at 0 and 3.
        const sparse = new Uint8Array(readFileSync(fixturePath('sparse_nulls.parquet')));
        expectValidDump(await parse(sparse, 'sparse_nulls.parquet'));

        // Without skipping, the window is the raw slice: nulls included, in order.
        const raw = await parse.preview(0, 'n', 0, 0, 100, false);
        if (raw.error !== undefined) {
            throw new Error(`unexpected codec failure: ${raw.codec}`);
        }
        expect(raw.total).toBe(6);
        expect(raw.nulls).toBe(4);
        expect(raw.values.map(v => v.value)).toEqual([1, null, null, 2, null, null]);

        // Skipping nulls scans the whole page for the 2 non-null values, keeps
        // their true (sparse) indices, and reports next = total (trailing nulls
        // absorbed) so the range spans the entire page — the 1-of-10000 case.
        const skipped = await parse.preview(0, 'n', 0, 0, 100, true);
        if (skipped.error !== undefined) {
            throw new Error(`codec failure: ${skipped.codec}`);
        }
        expect(skipped.values.map(v => v.value)).toEqual([1, 2]);
        expect(skipped.values.map(v => v.index)).toEqual([0, 3]);
        expect(skipped.total).toBe(6);
        expect(skipped.next).toBe(6); // whole page consumed → range 1–6 of 6, no next page
    });

    it('previews a logical column with the raw physical value alongside', async () => {
        const bytes = new Uint8Array(readFileSync(fixturePath('temporal.parquet')));
        expectValidDump(await parse(bytes, 'temporal.parquet'));

        // TIMESTAMP (INT64) displays an ISO datetime, but the bloom probe hashes
        // the raw microseconds int; the preview carries both. The displayed
        // string is localized (tz-naive), so assert only on the physical value.
        const ts = await parse.preview(0, 'ts', 0, 0, 100, false);
        if (ts.error !== undefined) {
            throw new Error(`unexpected codec failure: ${ts.codec}`);
        }
        expect(ts.values[0]!.physical).toBe(1_609_459_200_000_000); // µs since epoch (UTC)
        expect(typeof ts.values[0]!.value).toBe('string'); // the human datetime
        expect(ts.values.every(v => typeof v.physical === 'number')).toBe(true);
        expect(ts.values.every(v => v.value !== v.physical)).toBe(true);

        // DATE (INT32) displays an ISO date; physical is the day count.
        const d = await parse.preview(0, 'd', 0, 0, 100, false);
        if (d.error !== undefined) {
            throw new Error(`unexpected codec failure: ${d.codec}`);
        }
        expect(String(d.values[0]!.value)).toContain('2021-01-01');
        expect(d.values[0]!.physical).toBe(18628); // days since epoch

        // Plain string: display == what you'd type, so no physical overlay.
        const s = await parse.preview(0, 's', 0, 0, 100, false);
        if (s.error !== undefined) {
            throw new Error(`unexpected codec failure: ${s.codec}`);
        }
        expect(s.values.map(v => v.value)).toEqual(['alpha', 'bravo', 'charlie']);
        expect(s.values.every(v => v.physical === undefined)).toBe(true);
    });

    it('boots from a JSON dump + URL and probes via range reads, no re-parse', async () => {
        // The purist path: a full dump carries every offset, so rehydrating it
        // and attaching a range reader is all bloom/preview need -- the footer
        // is never re-parsed and the file is never downloaded whole.
        const bloomFile = new Uint8Array(
            readFileSync(fixturePath('data_index_bloom_encoding_with_length.parquet'))
        );
        const dumpJson = await parse(bloomFile, 'data_index_bloom_encoding_with_length.parquet');

        const server = await serveFixture(bloomFile, true);
        try {
            await parse.bootFromDump(dumpJson, server.url);

            // Bloom + preview now answer from the rehydrated slot, reading only
            // the spans the dump already located.
            expect((await parse.probeBloom(0, 'String', 'Hello')).mightContain).toBe(true);
            expect((await parse.probeBloom(0, 'String', 'zzzzzz-not-here')).mightContain).toBe(
                false
            );
            const page = await parse.preview(0, 'String', 0, 0, 100, false);
            if (page.error !== undefined) {
                throw new Error(`unexpected codec failure: ${page.codec}`);
            }
            expect(page.values.slice(0, 3).map(v => v.value)).toEqual(['Hello', 'This is', 'a']);

            // Every fetch the boot + probes issued was a bounded range request;
            // the file was never pulled in one whole-body GET.
            expect(server.ranges.length).toBeGreaterThan(0);
            expect(server.ranges.every(r => r !== null)).toBe(true);
        } finally {
            await server.close();
        }
    }, 60_000);

    it('decodes snappy chunks via por-que pure-python fallback', async () => {
        expectValidDump(await parse(data, 'alltypes_plain.snappy.parquet'));

        // por-que ships a pure-python snappy fallback used when the
        // python-snappy C extension is absent (as under pyodide), so SNAPPY
        // values now decode in-browser instead of returning codec_unavailable.
        const page = await parse.preview(0, 'id', 0, 0, 100, false);
        if (page.error !== undefined) {
            throw new Error(`unexpected codec failure: ${page.codec}`);
        }
        expect(page.values.map(v => v.value)).toEqual([6, 7]);
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
