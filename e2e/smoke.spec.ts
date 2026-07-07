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
    // The cell tooltip also carries the full column name + its stats.
    await expect(cell).toHaveAttribute('title', /^String\n/);
    await expect(cell).toHaveAttribute('title', /min 'Hello' · max 'today'/);
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
    await expect(cell).toHaveAttribute('title', /read only to evaluate a predicate/);
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
    await expect(cell).toHaveAttribute('title', /not read — not selected for output/);

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
    await expect(cells.nth(1)).toHaveAttribute('title', /not read — not selected for output/);
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

test('value preview degrades with a note on JSON-dump loads', async ({ page }) => {
    // A JSON load has no live worker file, so nothing can decode values.
    await page.goto('/#node=rg_0_col_String');
    await page
        .locator('#file-input')
        .setInputFiles(fixture('data_index_bloom_encoding_stats_expected.json'));

    const panel = page.locator('#info-panel-container');
    await expect(panel).toContainText('Column Chunk String');
    await expect(panel).toContainText('Value Preview');
    await expect(panel).toContainText('Decoding values needs the file bytes');
    await expect(panel.locator('.value-preview-btn')).toHaveCount(0);
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

test('diff mode: compare two files, sort, and return to file A intact', async ({ page }) => {
    await loadFixture(page, 'data_index_bloom_encoding_stats_expected.json');
    const viz = page.locator('#canvas-container svg');
    await expect(viz.locator('rect.segment')).not.toHaveCount(0);

    // Select a node first to prove the view survives the diff round trip.
    await viz.locator('rect.segment[data-segment-id="data_region"]').click();
    const panel = page.locator('#info-panel-container');
    await expect(panel).toContainText('Data Region');

    // Compare: the content section is swapped for the second drop target.
    await page.locator('#compare-btn').click();
    await expect(page.locator('#diff-drop-zone')).toBeVisible();
    await expect(page.locator('#file-content-section')).toBeHidden();
    await expect(page.locator('#diff-file-a')).toContainText('data_index_bloom_encoding_stats');

    // File B goes through the same validated boundary as file A.
    await page
        .locator('#diff-file-input')
        .setInputFiles(fixture('data_index_bloom_encoding_with_length_expected.json'));

    // Same data, different codec: 152 GZIP → 199 UNCOMPRESSED, delta +47.
    const table = page.locator('.diff-table');
    await expect(table).toBeVisible();
    const row = table.locator('tbody tr');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('String');
    await expect(row).toContainText('152 Bytes');
    await expect(row).toContainText('199 Bytes');
    await expect(row).toContainText('+47 Bytes (+30.9%)');
    // Codec AND encodings changed: both cells highlighted.
    await expect(row.locator('td.diff-changed')).toHaveCount(2);
    await expect(row.locator('td.diff-codec')).toContainText('GZIP → UNCOMPRESSED');

    // File-level and per-row-group totals render.
    const results = page.locator('#diff-results');
    await expect(results).toContainText('File Totals');
    await expect(results).toContainText('Row Group Totals');
    await expect(results).toContainText('14 rows');

    // Δ header sorts: first click descending, second ascending.
    const deltaHeader = page.locator('.diff-delta-header');
    await deltaHeader.click();
    await expect(deltaHeader).toHaveClass(/diff-sort-desc/);
    await deltaHeader.click();
    await expect(deltaHeader).toHaveClass(/diff-sort-asc/);
    await expect(row).toHaveCount(1);

    // Back: file A fully intact — selection, info panel, query matrix, hash.
    await page.locator('#diff-close-btn').click();
    await expect(page.locator('#diff-section')).toBeHidden();
    await expect(page.locator('#file-content-section')).toBeVisible();
    await expect(viz.locator('rect.segment[data-segment-id="data_region"]')).toHaveClass(
        /segment-selected/
    );
    await expect(panel).toContainText('Data Region');
    await expect(page.locator('.query-matrix .qm-cell')).toHaveCount(1);
    await expect(page).toHaveURL(/node=data_region/);
    await expect(page.locator('#loaded-file-source')).toContainText(
        'data_index_bloom_encoding_stats'
    );
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

    // Value preview: decode the String chunk in-browser and show real values.
    await viz.locator('rect.segment[data-segment-id="rg_0"]').click();
    await viz.locator('rect.segment[data-segment-id="rg_0_col_String"]').click();
    const panel = page.locator('#info-panel-container');
    await expect(panel).toContainText('Value Preview');
    await page.locator('.value-preview-btn').click();
    const preview = page.locator('.value-preview-result');
    await expect(preview).toContainText('14 values');
    await expect(preview).toContainText('Hello');
});
