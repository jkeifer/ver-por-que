/**
 * End-to-end smoke suite: load the app, feed it real fixtures through the
 * file input, and assert the visualizer + info panel render. The @slow test
 * drives a raw .parquet through the pyodide worker (needs `npm run wheel` and
 * network for the pyodide CDN); everything else runs offline.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';

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

test('renders a metadata-only export with the source suffix', async ({ page }) => {
    await loadFixture(page, 'metadata-export.json');
    await expect(page.locator('#loaded-file-source')).toContainText('(metadata-only export)');
    await expect(page.locator('#canvas-container svg rect.segment')).not.toHaveCount(0);
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
    await expect(page.locator('#canvas-container svg rect.segment')).not.toHaveCount(0);
});
