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
});

test('index segments decode their per-page stats', async ({ page }) => {
    await loadFixture(page, 'data_index_bloom_encoding_stats_expected.json');
    const viz = page.locator('#canvas-container svg');
    const panel = page.locator('#info-panel-container');

    // Column index → the actual per-page min/max, decoded to the column's type
    // (the raw stat bytes are base64 of 'Hello'/'today').
    await viz.locator('rect.segment[data-segment-id="index_region"]').click();
    await viz.locator('rect.segment[data-segment-id="index_column_index"]').click();
    await viz.locator('rect.segment[data-segment-id="colidx_rg0_String"]').click();
    await expect(panel).toContainText('Per-Page Statistics');
    const colTable = panel.locator('.index-table');
    await expect(colTable).toContainText('Hello');
    await expect(colTable).toContainText('today');

    // Offset index → the per-page seek map (first row + byte offset + size).
    await viz.locator('rect.segment[data-segment-id="index_offset_index"]').click();
    await viz.locator('rect.segment[data-segment-id="offidx_rg0_String"]').click();
    await expect(panel).toContainText('Page Locations');
    await expect(panel.locator('.index-table th')).toContainText([
        'Page',
        'First row',
        'Offset',
        'Size',
    ]);
});

test('renders a metadata-only export with the source suffix', async ({ page }) => {
    await loadFixture(page, 'metadata-export.json');
    await expect(page.locator('#loaded-file-source')).toContainText('(metadata-only export)');
    await expect(page.locator('#canvas-container svg rect.segment')).not.toHaveCount(0);
});

test('degraded metadata-only card offers the upgrade button', async ({ page }) => {
    // The fixture records a fetchable http(s) source, so degraded cards can
    // offer to re-parse the full structure from it. The column-index node is
    // span-only in a metadata-only dump -> its card carries the upgrade button.
    await page.goto('/#node=colidx_rg0_String');
    await page.locator('#file-input').setInputFiles(fixture('metadata-export.json'));

    await expect(page.locator('.recovery-btn[data-action="upgrade"]')).toBeVisible();
    // The read summary is limited to row-group detail on a metadata-only dump,
    // so it carries the same upgrade button.
    await expect(page.locator('.query-summary-card .recovery-btn')).toBeVisible();
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

test('query simulation: live matrix, pruning, projection, permalink', async ({ page }) => {
    await loadFixture(page, 'data_index_bloom_encoding_stats_expected.json');
    const viz = page.locator('#canvas-container svg');
    await expect(viz.locator('rect.segment')).not.toHaveCount(0);

    // Default state: no predicates, all columns selected — the fixture's one
    // row group × one column cell reads green. There is no Run button.
    const cell = page.locator('.query-matrix .qm-cell');
    await expect(cell).toHaveCount(1);
    await expect(cell).toHaveClass(/qm-read/);
    await expect(page.locator('#query-run-btn')).toHaveCount(0);
    const summary = page.locator('#query-summary');
    await expect(summary).toContainText('up to 14 of 14');
    await expect(summary).toContainText('1 of 1 read');

    // Column header hover shows the full name + decoded stats.
    const header = page.locator('.query-matrix th').nth(1);
    await expect(header).toHaveAttribute('title', /String/);
    await expect(header).toHaveAttribute('title', /min 'Hello' · max 'today'/);

    // Hovering a cell shows the instant floating tooltip (native `title` is too
    // slow on these tiny targets); leaving hides it and restores the title.
    const tip = page.locator('.qm-tip');
    await cell.hover();
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('String');
    await expect(tip).toContainText('Read and returned');
    await page.locator('.query-matrix-section h2').hover();
    await expect(tip).toBeHidden();
    await expect(cell).toHaveAttribute('title', /String/);

    // A fresh predicate row is incomplete (empty value): it's flagged with a
    // muted hint, excluded from evaluation, and nothing breaks.
    await page.locator('#query-add-predicate').click();
    await page.locator('.qp-column').selectOption('String');
    await expect(page.locator('.qp-hint')).toHaveText('incomplete — not applied');
    await expect(cell).toHaveClass(/qm-read/);
    // The predicate row shows the selected column's decoded stats live.
    await expect(page.locator('.qp-stats')).toContainText("min 'Hello' · max 'today'");
    await expect(page.locator('.qp-stats')).toContainText('0 nulls');

    // String > 'zzz' prunes the only row group LIVE — typing the value is
    // enough, no button click: the cell turns red with the reason.
    await page.locator('.qp-op').selectOption('gt');
    await page.locator('.qp-value').fill('zzz');
    await expect(cell).toHaveClass(/qm-pruned/);
    await expect(page.locator('.qp-hint')).toHaveText('');
    await expect(cell).toHaveAttribute('title', /max value 'today' < query value 'zzz'/);
    // The cell tooltip carries the column name, then the status + its rationale.
    await expect(cell).toHaveAttribute('title', /^String\n/);
    await expect(cell).toHaveAttribute('title', /Skipped — max value 'today' < query value 'zzz'/);
    // The summary follows: rows are an upper bound, so "up to".
    await expect(summary).toContainText('up to 0 of 14');
    await expect(summary).toContainText('0 of 1 read');
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
    await expect(cell).toHaveClass(/qm-pruned/);
    await expect(summary).toContainText('up to 0 of 14');

    // String = 'Hello' keeps the row group: green again, live.
    await page.locator('.qp-op').selectOption('eq');
    await page.locator('.qp-value').fill('Hello');
    await expect(cell).toHaveClass(/qm-read/);
    await expect(summary).toContainText('up to 14 of 14');

    // Deselecting the output column while a predicate still reads it for
    // evaluation turns the cell yellow (read, but not projected) — it still
    // counts as read in the summary.
    await page.locator('.query-columns input[data-column="String"]').uncheck();
    await expect(cell).toHaveClass(/qm-eval/);
    await expect(cell).toHaveAttribute('title', /Read only to evaluate a predicate/);
    await expect(summary).toContainText('1 of 1 read');

    // Select all / Deselect all act on every return-column checkbox.
    await page.locator('#query-deselect-all').click();
    await expect(page.locator('.query-columns input[data-column="String"]')).not.toBeChecked();
    await page.locator('#query-select-all').click();
    await expect(page.locator('.query-columns input[data-column="String"]')).toBeChecked();
    await expect(cell).toHaveClass(/qm-read/);

    // With no predicate left on the column, deselecting it grays the cell
    // out instead (not read at all) — again live, no button.
    await page.locator('.qp-remove').click();
    await page.locator('.query-columns input[data-column="String"]').uncheck();
    await expect(cell).toHaveClass(/qm-skip/);
    await expect(cell).toHaveAttribute('title', /Not read — column not selected for output/);

    // Clear drops predicates but keeps the projection: still gray. Re-checking
    // the column restores the default state and drops the hash param.
    await page.locator('#query-clear-btn').click();
    await expect(cell).toHaveClass(/qm-skip/);
    await page.locator('.query-columns input[data-column="String"]').check();
    await expect(cell).toHaveClass(/qm-read/);
    await expect(summary).toContainText('up to 14 of 14');
    await expect(page.locator('rect.segment-dimmed')).toHaveCount(0);
    await expect(page).not.toHaveURL(/q=/);
});

test('query cell precedence: unprojected columns stay gray in a pruned row group', async ({
    page,
}) => {
    // Two row groups × two columns (a INT64 [1,2], b STRING ['a','c']).
    await loadFixture(page, 'sort_columns_expected.json');
    const cells = page.locator('.query-matrix .qm-cell');
    await expect(cells).toHaveCount(4);

    // Uncheck b (no predicate on it), then prune everything via a > 100.
    await page.locator('.query-columns input[data-column="b"]').uncheck();
    await page.locator('#query-add-predicate').click();
    await page.locator('.qp-column').selectOption('a');
    await page.locator('.qp-op').selectOption('gt');
    await page.locator('.qp-value').fill('100');

    // Cells are row-major (RG0 a, RG0 b, RG1 a, RG1 b): a's cells go red,
    // while b's stay gray — never read, so pruning them saves nothing.
    await expect(cells.nth(0)).toHaveClass(/qm-pruned/);
    await expect(cells.nth(2)).toHaveClass(/qm-pruned/);
    await expect(cells.nth(1)).toHaveClass(/qm-skip/);
    await expect(cells.nth(3)).toHaveClass(/qm-skip/);

    // Gray tooltips never show a pruning reason.
    await expect(cells.nth(1)).toHaveAttribute(
        'title',
        /Not read — column not selected for output/
    );
    await expect(cells.nth(1)).not.toHaveAttribute('title', /pruned/);

    // Summary: red is would-have-read-but-skipped; gray is simply not read.
    const summary = page.locator('#query-summary');
    await expect(summary).toContainText('up to 0 of 6');
    await expect(summary).toContainText('0 of 2 read');
    await expect(summary).toContainText('0 of 4 read');
});

test('lens switcher: treemap renders, selection and dimming survive switching', async ({
    page,
}) => {
    await loadFixture(page, 'data_index_bloom_encoding_stats_expected.json');
    await expect(page.locator('#canvas-container svg rect.segment')).not.toHaveCount(0);

    // Dim the only row group first so the treemap inherits the query overlay
    // (the simulation is live — typing the value is enough).
    await page.locator('#query-add-predicate').click();
    await page.locator('.qp-column').selectOption('String');
    await page.locator('.qp-op').selectOption('gt');
    await page.locator('.qp-value').fill('zzz');
    await expect(page.locator('.query-matrix .qm-cell')).toHaveClass(/qm-pruned/);

    // Switch lens: treemap rects render over the same tree, hash gains lens=.
    await page.locator('#lens-treemap').click();
    const treemap = page.locator('#canvas-container svg.treemap');
    await expect(treemap.locator('rect.segment')).not.toHaveCount(0);
    await expect(page).toHaveURL(/lens=treemap/);

    // A click selects the node in the info panel and drills into its children.
    await treemap.locator('rect.segment[data-segment-id="data_region"]').click();
    const panel = page.locator('#info-panel-container');
    await expect(panel).toContainText('Data Region');
    await expect(page).toHaveURL(/node=data_region/);

    // Query dimming applies in this lens too: the pruned row group is dimmed.
    const rowGroupRect = treemap.locator('rect.segment[data-segment-id="rg_0"]');
    await expect(rowGroupRect).toHaveClass(/segment-dimmed/);

    // Drill further; the breadcrumb tracks the path back out.
    await rowGroupRect.click();
    await expect(panel).toContainText('Row Group');
    await expect(page.locator('.treemap-breadcrumb')).toContainText('DATA');

    // Switch back: the selection carries over (rg_0 re-selected by id) and the
    // byte-layout rect is both selected and still dimmed; lens= drops off.
    await page.locator('#lens-bytes').click();
    const byteRect = page.locator(
        '#canvas-container svg:not(.treemap) rect.segment[data-segment-id="rg_0"]'
    );
    await expect(byteRect).toHaveClass(/segment-selected/);
    await expect(byteRect).toHaveClass(/segment-dimmed/);
    await expect(page).not.toHaveURL(/lens=/);

    // A lens=treemap permalink loads straight into the treemap (IndexedDB
    // restore). goto with only a hash difference is a same-document
    // navigation, so reload to actually re-run the app against the new hash.
    await page.goto('/#lens=treemap');
    await page.reload();
    await expect(page.locator('#canvas-container svg.treemap rect.segment')).not.toHaveCount(0);
});

test('bloom filter probe is available on a JSON dump with a fetchable source', async ({ page }) => {
    // This dump records bloom_filter_offset AND length, so the bloom node
    // exists, and its fetchable source lets the probe boot a range reader on
    // demand -- the interactive control renders, not a dead note.
    await loadFixture(page, 'data_index_bloom_encoding_with_length_expected.json');

    const viz = page.locator('#canvas-container svg');
    // Bloom filters now live under the Index region, in the Bloom Filters group.
    await viz.locator('rect.segment[data-segment-id="index_region"]').click();
    await viz.locator('rect.segment[data-segment-id="index_bloom_filter"]').click();
    await viz.locator('rect.segment[data-segment-id="bloomfilter_rg0_String"]').click();

    const panel = page.locator('#info-panel-container');
    await expect(panel).toContainText('Bloom Filter');
    await expect(panel).toContainText('Probe a Value');
    await expect(panel.locator('.bloom-probe-btn')).toHaveCount(1);
});

test('value preview is available on a JSON dump with a fetchable source', async ({ page }) => {
    // The dump records a fetchable source, so the preview boots a range reader
    // on demand -- the interactive control renders, not a dead note. Value
    // preview lives on data pages, not the column chunk.
    await page.goto('/#node=rg_0_col_String_data_0');
    await page
        .locator('#file-input')
        .setInputFiles(fixture('data_index_bloom_encoding_stats_expected.json'));

    const panel = page.locator('#info-panel-container');
    await expect(panel).toContainText('Data page DATA0');
    await expect(panel).toContainText('Value Preview');
    await expect(panel.locator('.value-preview-btn')).toHaveCount(1);
});

test('decodes a GeoParquet geometry column (WKB stats + GeoJSON copy)', async ({ page }) => {
    await page.goto('/#node=rg_0_col_geometry');
    await page.locator('#file-input').setInputFiles(fixture('geoparquet_expected.json'));

    const panel = page.locator('#info-panel-container');
    await expect(panel).toContainText('Column Chunk geometry');
    // GeoParquet geometry (no logical type) is named, not shown as BYTE_ARRAY.
    await expect(panel).toContainText('WKB geometry (GeoParquet)');
    // Spatial extent from the `geo` metadata, and the WKB max decoded (not base64).
    await expect(panel).toContainText('Geospatial Statistics');
    await expect(panel).toContainText('MULTIPOLYGON');
    // The decoded geometry stat offers a copy-as-GeoJSON button AND a physical
    // (#) copy of the raw base64 WKB the bloom probe hashes.
    await expect(panel.locator('button.copy-btn[title="Copy as GeoJSON"]').first()).toBeVisible();
    await expect(
        panel.locator('button.copy-btn[title^="Copy physical value"]').first()
    ).toBeVisible();
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

test('service worker serves the app shell offline after a warm load', async ({ page, context }) => {
    // The SW registers on the production build served by `vite preview`.
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    // clients.claim() takes control of this already-open page.
    await expect
        .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
        .toBe(true);
    // A controlled reload runs every shell request through the SW, which awaits
    // each cache.put before returning -- so once reload() resolves, the shell
    // is cached.
    await page.reload();

    // Cut the network and reload: the shell must come entirely from cache.
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#drop-zone')).toBeVisible();

    // The JSON path needs no network (no pyodide), so a dump still renders.
    await page.locator('#file-input').setInputFiles(fixture('metadata-export.json'));
    await expect(page.locator('#loaded-file-source')).toContainText('(metadata-only export)');
    await expect(page.locator('#canvas-container svg rect.segment')).not.toHaveCount(0);

    await context.setOffline(false);
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

    // Bloom filter probe: needs a file whose footer records the filter's
    // length (data_index_bloom_encoding_stats records only the offset, so no
    // bloom node exists for it). The worker is already booted; this parse and
    // the probes against its current-file slot are fast.
    await page
        .locator('#file-input')
        .setInputFiles(fixture('data_index_bloom_encoding_with_length.parquet'));
    await expect(source).toContainText('data_index_bloom_encoding_with_length.parquet');

    await viz.locator('rect.segment[data-segment-id="index_region"]').click();
    await viz.locator('rect.segment[data-segment-id="index_bloom_filter"]').click();
    await viz.locator('rect.segment[data-segment-id="bloomfilter_rg0_String"]').click();
    await expect(page.locator('#info-panel-container')).toContainText('Bloom Filter');

    // 'Hello' is in the column (footer stats min); the filter can only say maybe.
    // A "maybe" renders the probed block with all eight checked bits set (no
    // misses). The verdict + lineage sit up top in the status's live layer
    // (covering the idle hint; the sibling ghost layer carries the same
    // classes, permanently hidden, to reserve the height); the probed block's
    // grid/marks render in the .bloom-scroll strip.
    const live = page.locator('.bloom-status-live');
    const result = live.locator('.bloom-verdict');
    const strip = page.locator('.bloom-scroll');
    await page.locator('.bloom-probe-value').fill('Hello');
    await page.locator('.bloom-probe-btn').click();
    await expect(result).toContainText('maybe present');
    await expect(strip.locator('svg.bloom-block').first()).toBeVisible();
    await expect(live.locator('.bloom-lineage')).toContainText('8/8 bits set');
    await expect(strip.locator('.bloom-bit-miss')).toHaveCount(0);

    // Garbage gets the exact answer: definitely absent — at least one miss bit,
    // which is the visual proof the reader can skip the row group.
    await page.locator('.bloom-probe-value').fill('zzzzzz-not-here');
    await page.locator('.bloom-probe-btn').click();
    await expect(result).toContainText('definitely not present');
    expect(await strip.locator('.bloom-bit-miss').count()).toBeGreaterThan(0);

    // Value preview: decode the String column's data page in-browser and show
    // real values (the preview lives on the page, not the chunk). Navigate back
    // out of the Index region to the data region first (bloom filters now live
    // under Index, a different subtree than the row groups).
    await viz.locator('rect.segment[data-segment-id="data_region"]').click();
    await viz.locator('rect.segment[data-segment-id="rg_0"]').click();
    await viz.locator('rect.segment[data-segment-id="rg_0_col_String"]').click();
    await viz.locator('rect.segment[data-segment-id="rg_0_col_String_data_0"]').click();
    const panel = page.locator('#info-panel-container');
    await expect(panel).toContainText('Value Preview');
    await page.locator('.value-preview-btn').click();
    const preview = page.locator('.value-preview-result');
    await expect(preview).toContainText('14 values');
    await expect(preview).toContainText('Hello');

    // Dictionary preview: the String column is dictionary-encoded, so its
    // dictionary page decodes to the column's distinct values (incl. 'Hello').
    await viz.locator('rect.segment[data-segment-id="rg_0_col_String_dict"]').click();
    await expect(panel).toContainText('Dictionary Values');
    await page.locator('.value-preview-btn').click();
    await expect(preview).toContainText('Hello');
});

test(
    'bloom density strip renders and probe highlights + clears',
    { tag: '@slow' },
    async ({ page }) => {
        test.skip(!hasWheel, 'run `npm run wheel` to stage the por-que/hctef wheels first');
        // First parse downloads the ~12MB pyodide runtime from the CDN.
        test.setTimeout(240_000);

        // Every column of this fixture carries a real, populated bloom filter.
        await loadFixture(page, 'weather_station_daily.parquet');
        const source = page.locator('#loaded-file-source');
        await expect(source).toContainText('weather_station_daily.parquet', { timeout: 210_000 });

        const viz = page.locator('#canvas-container svg');
        // Bloom filters live under the Index region, in the Bloom Filters group.
        await viz.locator('rect.segment[data-segment-id="index_region"]').click();
        await viz.locator('rect.segment[data-segment-id="index_bloom_filter"]').click();
        await viz.locator('rect.segment[data-segment-id="bloomfilter_rg0_temperature"]').click();

        const panel = page.locator('#info-panel-container');
        await expect(panel).toContainText('Probe a Value');

        // Base state: the density strip AND the virtualized block strip are
        // visible BEFORE any probe, and Clear is disabled. Only the visible window
        // of blocks is mounted (.bloom-block-cell), and their grids lazily fill,
        // so more than one bloom-block svg renders. The strip carries ONE viewport
        // box (the scrollbar thumb), narrower than the strip (not all fit).
        await expect(panel.locator('svg.bloom-strip')).toBeVisible();
        await expect(panel.locator('.bloom-scroll svg.bloom-block').first()).toBeVisible();
        await expect(panel).toContainText('% full');
        expect(await panel.locator('.bloom-block-cell').count()).toBeGreaterThan(1);
        await expect
            .poll(async () => panel.locator('.bloom-scroll svg.bloom-block').count())
            .toBeGreaterThan(1);
        await expect(page.locator('.bloom-probe-clear')).toBeDisabled();
        const strip = panel.locator('svg.bloom-strip');
        const box = panel.locator('.bloom-strip-viewport');
        await expect(box).toHaveCount(1);
        expect(Number(await box.getAttribute('width'))).toBeLessThan(
            Number(await strip.getAttribute('width'))
        );

        // The block strip overflows its panel, and the density strip is its
        // scrollbar: pressing the strip near its right end scrubs the strip
        // (scrollLeft moves off 0) and the viewport box follows.
        const scroll = panel.locator('.bloom-scroll');
        await strip.click({ position: { x: (await strip.boundingBox())!.width - 4, y: 12 } });
        await expect.poll(async () => scroll.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
        await expect.poll(async () => Number(await box.getAttribute('x'))).toBeGreaterThan(0);

        // Idle state shows the explanatory hint, not a verdict. (Scope result
        // locators to the live layer: the reserved-height ghost layer carries
        // the same verdict/lineage classes, permanently hidden.)
        const liveLayer = panel.locator('.bloom-status-live');
        await expect(panel.locator('p.bloom-probe-hint')).toBeVisible();
        await expect(liveLayer.locator('.bloom-verdict')).toHaveCount(0);

        // Probe a value: the verdict + lineage layer covers the hint (which
        // stays mounted, visibility-hidden, keeping the area's reservation),
        // hit/miss marks land on the probed block's grid, the probed overview
        // cell is marked, its row label flagged, and Clear enabled.
        const result = liveLayer.locator('.bloom-verdict');
        await page.locator('.bloom-probe-value').fill('20.5');
        await page.locator('.bloom-probe-btn').click();
        await expect(result).toContainText('present');
        await expect(panel.locator('p.bloom-probe-hint')).toBeHidden();
        await expect(liveLayer.locator('.bloom-lineage')).toContainText('bits set');
        await expect(panel.locator('.bloom-strip-cell.probed')).toHaveCount(1);
        await expect(panel.locator('.bloom-block-label.probed')).toContainText('probed');
        await expect(page.locator('.bloom-probe-clear')).toBeEnabled();
        const marked = await panel.locator('.bloom-bit-hit, .bloom-bit-miss').count();
        expect(marked).toBe(8);

        // Clear: the verdict is gone (hint restored), Clear disabled.
        await page.locator('.bloom-probe-clear').click();
        await expect(page.locator('.bloom-probe-clear')).toBeDisabled();
        await expect(panel.locator('.bloom-strip-cell.probed')).toHaveCount(0);
        await expect(result).toHaveCount(0);
        await expect(panel.locator('p.bloom-probe-hint')).toBeVisible();
    }
);

test('query matrix consults bloom filters for = predicates', { tag: '@slow' }, async ({ page }) => {
    test.skip(!hasWheel, 'run `npm run wheel` to stage the por-que/hctef wheels first');
    test.setTimeout(240_000);

    // Every column of this fixture carries a bloom filter, and a raw-parquet
    // load wires the probe straight at the worker's current file.
    await loadFixture(page, 'weather_station_daily.parquet');
    await expect(page.locator('#loaded-file-source')).toContainText(
        'weather_station_daily.parquet',
        { timeout: 210_000 }
    );

    // An = predicate on a bloom-filtered column with an in-range value: some
    // row groups survive stats pruning and get probed asynchronously.
    await page.locator('#query-add-predicate').click();
    await page.locator('.qp-column').selectOption('temperature');
    await page.locator('.qp-op').selectOption('eq');
    await page.locator('.qp-value').fill('20.5');

    // The probes run against the (warm) worker; bloom markers appear on the
    // matrix cells when the results land — proof the matrix consulted them.
    await expect
        .poll(async () => page.locator('.query-matrix .qm-bloom').count(), { timeout: 120_000 })
        .toBeGreaterThan(0);

    // Clearing the query drops the markers.
    await page.locator('#query-clear-btn').click();
    await expect(page.locator('.query-matrix .qm-bloom')).toHaveCount(0);
});

test(
    'decodes geometry values in the preview through pyodide',
    { tag: '@slow' },
    async ({ page }) => {
        test.skip(!hasWheel, 'run `npm run wheel` to stage the por-que/hctef wheels first');
        test.setTimeout(240_000);

        // Permalink targets the geometry data page; it applies once the parse lands.
        await page.goto('/#node=rg_0_col_geometry_data_0');
        await page.locator('#file-input').setInputFiles(fixture('geoparquet.parquet'));

        const panel = page.locator('#info-panel-container');
        await expect(panel).toContainText('Value Preview', { timeout: 210_000 });
        await page.locator('.value-preview-btn').click();

        // The live worker decodes the WKB BYTE_ARRAY page; the cells show geometry
        // summaries (not base64), each with a copy-as-GeoJSON button.
        const preview = page.locator('.value-preview-result');
        await expect(preview).toContainText('POINT(30 10)');
        await expect(preview).toContainText('MULTIPOLYGON');
        await expect(
            preview.locator('button.copy-btn[title="Copy as GeoJSON"]').first()
        ).toBeVisible();
    }
);
