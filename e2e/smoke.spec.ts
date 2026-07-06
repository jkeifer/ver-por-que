/**
 * End-to-end smoke suite: load the app, feed it real fixtures through the
 * file input, and assert the visualizer + info panel render. The @slow test
 * drives a raw .parquet through the pyodide worker (needs `npm run wheel` and
 * network for the pyodide CDN); everything else runs offline.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { validateFile } from '../src/generated/validate.js';

const fixture = (name: string): string =>
    fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));

// Same self-skip condition as the vitest pyodide integration test.
const hasWheel = existsSync(
    fileURLToPath(new URL('../static/vendor/manifest.json', import.meta.url))
);

async function loadFixture(page: Page, name: string): Promise<void> {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(fixture(name));
}

test('shows the drop zone on load', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#drop-zone')).toBeVisible();
    await expect(page.locator('#drop-zone')).toContainText('Drop a Parquet or JSON file here');
});

test('renders a full dump and drills into a row group', async ({ page }) => {
    await loadFixture(page, 'data_index_bloom_encoding_stats_expected.json');

    const viz = page.locator('#canvas-container svg');
    await expect(viz.locator('rect.segment')).not.toHaveCount(0);

    // Drill down: DATA region → row group 0 → info panel shows its layout.
    await viz.locator('rect.segment[data-segment-id="data_region"]').click();
    await viz.locator('rect.segment[data-segment-id="rg_0"]').click();

    const panel = page.locator('#info-panel-container');
    await expect(panel).toContainText('Physical Layout');
    await expect(panel).toContainText('Row Group');
    // A JSON-dump load has no original file bytes: hex degrades to a note.
    await expect(panel).toContainText('Raw bytes are not available');
});

test('renders a metadata-only export with the source suffix', async ({ page }) => {
    await loadFixture(page, 'metadata-export.json');
    await expect(page.locator('#loaded-file-source')).toContainText('(metadata-only export)');
    await expect(page.locator('#canvas-container svg rect.segment')).not.toHaveCount(0);
});

test('permalink hash selects the node when data arrives', async ({ page }) => {
    // The hash is read AFTER a dump loads, so it applies to data that arrives
    // later via the file input (or an IndexedDB restore).
    await page.goto('/#node=rg_0_col_String');
    await page
        .locator('#file-input')
        .setInputFiles(fixture('data_index_bloom_encoding_stats_expected.json'));

    const panel = page.locator('#info-panel-container');
    await expect(panel).toContainText('Column Chunk String');
    // Ancestors were drilled down: the target's own rect is rendered + selected.
    await expect(page.locator('rect.segment[data-segment-id="rg_0_col_String"]')).toHaveClass(
        /segment-selected/
    );

    // Flagship flow: fresh navigation restores the file from IndexedDB and the
    // permalink re-applies to the restored dump.
    await page.goto('/#node=rg_0_col_String');
    await expect(panel).toContainText('Column Chunk String');

    // Clicking a node rewrites the hash; reset drops it.
    await page.locator('rect.segment[data-segment-id="magic_header"]').click();
    await expect(page).toHaveURL(/#node=magic_header$/);
    await page.locator('#reset-btn').click();
    await expect(page.locator('#drop-zone')).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
});

test('query simulation: matrix, pruning, projection, permalink', async ({ page }) => {
    await loadFixture(page, 'data_index_bloom_encoding_stats_expected.json');
    const viz = page.locator('#canvas-container svg');
    await expect(viz.locator('rect.segment')).not.toHaveCount(0);

    // Default state: no predicates, all columns selected — the fixture's one
    // row group × one column cell reads green.
    const cell = page.locator('.query-matrix .qm-cell');
    await expect(cell).toHaveCount(1);
    await expect(cell).toHaveClass(/qm-read/);
    const summary = page.locator('#query-summary');
    await expect(summary).toHaveText('would read 1 of 1 column chunk in 1 of 1 row group');

    // String > 'zzz' prunes the only row group: the cell turns red and its
    // tooltip carries the reason.
    await page.locator('#query-add-predicate').click();
    await page.locator('.qp-column').selectOption('String');
    await page.locator('.qp-op').selectOption('gt');
    await page.locator('.qp-value').fill('zzz');
    await page.locator('#query-run-btn').click();

    await expect(cell).toHaveClass(/qm-pruned/);
    await expect(cell).toHaveAttribute('title', /max value 'today' < query value 'zzz'/);
    await expect(summary).toHaveText(
        'would read 0 of 1 column chunk in 0 of 1 row group, 0 of 1 page'
    );
    await expect(page).toHaveURL(/q=/);

    // The visualizer dims the pruned row group (rect renders inside the data
    // region drill-down, already dimmed)...
    await viz.locator('rect.segment[data-segment-id="data_region"]').click();
    const rowGroup = viz.locator('rect.segment[data-segment-id="rg_0"]');
    await expect(rowGroup).toHaveClass(/segment-dimmed/);

    // ...and the evaluated node's info panel explains the decision.
    await rowGroup.click();
    const panel = page.locator('#info-panel-container');
    await expect(panel).toContainText('Query Pruning');
    await expect(panel).toContainText("max value 'today' < query value 'zzz'");

    // The query round-trips through the permalink (IndexedDB restore).
    await page.reload();
    await expect(summary).toHaveText(
        'would read 0 of 1 column chunk in 0 of 1 row group, 0 of 1 page'
    );

    // String = 'Hello' keeps the row group: green again.
    await page.locator('.qp-op').selectOption('eq');
    await page.locator('.qp-value').fill('Hello');
    await page.locator('#query-run-btn').click();
    await expect(cell).toHaveClass(/qm-read/);
    await expect(summary).toHaveText(
        'would read 1 of 1 column chunk in 1 of 1 row group, 1 of 1 page'
    );

    // Deselecting the output column grays the cell out (not read).
    await page.locator('.query-columns input[data-column="String"]').uncheck();
    await expect(cell).toHaveClass(/qm-skip/);
    await expect(cell).toHaveAttribute('title', 'not selected for output — not read');

    // Clear restores the default all-green state and drops the hash param.
    await page.locator('#query-clear-btn').click();
    await expect(cell).toHaveClass(/qm-read/);
    await expect(summary).toHaveText('would read 1 of 1 column chunk in 1 of 1 row group');
    await expect(page.locator('rect.segment-dimmed')).toHaveCount(0);
    await expect(page).not.toHaveURL(/q=/);
});

test('bloom filter probe degrades with a note on JSON-dump loads', async ({ page }) => {
    // This dump records bloom_filter_offset AND length, so the bloom node
    // exists -- but a JSON load has no live worker file to probe against.
    await loadFixture(page, 'data_index_bloom_encoding_with_length_expected.json');

    const viz = page.locator('#canvas-container svg');
    await viz.locator('rect.segment[data-segment-id="data_region"]').click();
    await viz.locator('rect.segment[data-segment-id="bloomfilter_rg0_String"]').click();

    const panel = page.locator('#info-panel-container');
    await expect(panel).toContainText('Bloom Filter');
    await expect(panel).toContainText('Probe a Value');
    await expect(panel).toContainText('Probing needs the filter bytes');
    await expect(panel.locator('.bloom-probe-btn')).toHaveCount(0);
});

test('downloads the loaded dump as re-validating JSON', async ({ page }) => {
    await loadFixture(page, 'data_index_bloom_encoding_stats_expected.json');
    await expect(page.locator('#loaded-file-source')).toContainText('.parquet');

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#download-dump-btn').click();
    const download = await downloadPromise;

    // Named after the source basename (the fixture's source is a .parquet URL).
    expect(download.suggestedFilename()).toBe('data_index_bloom_encoding_stats.dump.json');
    expect(download.suggestedFilename()).toMatch(/\.dump\.json$/);

    // The exported JSON passes back through the ajv validation boundary.
    const path = await download.path();
    const dump: unknown = JSON.parse(readFileSync(path, 'utf8'));
    expect(validateFile(dump)).toBe(true);
});

test('reset returns to the drop zone', async ({ page }) => {
    await loadFixture(page, 'metadata-export.json');
    await page.locator('#reset-btn').click();
    await expect(page.locator('#drop-zone')).toBeVisible();
});

test('parses a raw .parquet through pyodide', { tag: '@slow' }, async ({ page }) => {
    test.skip(!hasWheel, 'run `npm run wheel` to stage the por-que/hctef wheels first');
    // First parse downloads the ~12MB pyodide runtime from the CDN.
    test.setTimeout(240_000);

    await loadFixture(page, 'data_index_bloom_encoding_stats.parquet');

    const source = page.locator('#loaded-file-source');
    await expect(source).toContainText('data_index_bloom_encoding_stats.parquet', {
        timeout: 210_000,
    });
    // A worker-produced dump is a full dump, never a metadata-only export.
    await expect(source).not.toContainText('(metadata-only export)');
    const viz = page.locator('#canvas-container svg');
    await expect(viz.locator('rect.segment')).not.toHaveCount(0);

    // Hex inspector: the header magic is readable straight off the wire.
    await viz.locator('rect.segment[data-segment-id="magic_header"]').click();
    const hexView = page.locator('#info-panel-container .hex-view');
    await expect(hexView).toContainText('50 41 52 31');
    await expect(hexView).toContainText('PAR1');

    // Bloom filter probe: needs a file whose footer records the filter's
    // length (data_index_bloom_encoding_stats records only the offset, so no
    // bloom node exists for it). The worker is already booted; this parse and
    // the probes against its current-file slot are fast.
    await page
        .locator('#file-input')
        .setInputFiles(fixture('data_index_bloom_encoding_with_length.parquet'));
    await expect(source).toContainText('data_index_bloom_encoding_with_length.parquet');

    await viz.locator('rect.segment[data-segment-id="data_region"]').click();
    await viz.locator('rect.segment[data-segment-id="bloomfilter_rg0_String"]').click();
    await expect(page.locator('#info-panel-container')).toContainText('Bloom Filter');

    // 'Hello' is in the column (footer stats min); the filter can only say maybe.
    const result = page.locator('.bloom-probe-result');
    await page.locator('.bloom-probe-value').fill('Hello');
    await page.locator('.bloom-probe-btn').click();
    await expect(result).toContainText('maybe present');

    // Garbage gets the exact answer: definitely absent.
    await page.locator('.bloom-probe-value').fill('zzzzzz-not-here');
    await page.locator('.bloom-probe-btn').click();
    await expect(result).toContainText('definitely not present');
});
