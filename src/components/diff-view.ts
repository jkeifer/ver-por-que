/**
 * Diff-mode renderer: the comparison table plus totals cards, built from a
 * business-layer FileDiff. Deliberately a table, not dual visualizers — the
 * workshop exercise is "same data, different codecs/encodings", and numbers
 * side by side answer that faster than two pictures.
 */
import { escapeHtml } from './info-panel-manager';
import { formatBytes, formatNumber } from '../format';
import type { ChunkDiff, FileDiff } from '../business/diff';

/** Signed human delta with a percentage of the A size, e.g. "+47 Bytes (+30.9%)". */
export function formatDelta(delta: number, base: number): string {
    if (delta === 0) {
        return '±0';
    }
    const sign = delta > 0 ? '+' : '-';
    const pct = base > 0 ? ` (${sign}${((Math.abs(delta) / base) * 100).toFixed(1)}%)` : '';
    return `${sign}${formatBytes(Math.abs(delta))}${pct}`;
}

/** A ↔ B cell: one value when equal, "a → b" with the changed class when not. */
function changeCell(a: string, b: string, extraClass: string): string {
    return a === b
        ? `<td class="${extraClass}">${escapeHtml(a)}</td>`
        : `<td class="${extraClass} diff-changed">${escapeHtml(a)} → ${escapeHtml(b)}</td>`;
}

function chunkRow(c: ChunkDiff): string {
    const deltaClass = c.delta > 0 ? 'diff-pos' : c.delta < 0 ? 'diff-neg' : 'diff-zero';
    const size = (compressed: number, uncompressed: number): string =>
        `<td class="diff-num" title="${escapeHtml(formatBytes(uncompressed))} uncompressed">` +
        `${escapeHtml(formatBytes(compressed))}</td>`;
    return (
        `<tr>` +
        `<td class="diff-num">${c.rowGroup}</td>` +
        `<td class="diff-col" title="${escapeHtml(c.column)}">${escapeHtml(c.column)}</td>` +
        size(c.compressedA, c.uncompressedA) +
        size(c.compressedB, c.uncompressedB) +
        `<td class="diff-num ${deltaClass}">${escapeHtml(formatDelta(c.delta, c.compressedA))}</td>` +
        changeCell(c.codecA, c.codecB, 'diff-codec') +
        changeCell(
            [...c.encodingsA].sort().join(', '),
            [...c.encodingsB].sort().join(', '),
            'diff-encodings'
        ) +
        `</tr>`
    );
}

function totalsCards(diff: FileDiff, labelA: string, labelB: string): string {
    const item = (label: string, value: string): string =>
        `<div class="info-item"><span class="info-label">${escapeHtml(label)}</span>` +
        `<span class="info-value">${escapeHtml(value)}</span></div>`;
    const t = diff.total;
    const fileCard =
        `<div class="info-section regular-card"><h5 class="info-section-title">File Totals</h5>` +
        `<div class="info-grid">` +
        item(`A: ${labelA}`, `${formatBytes(t.compressedA)} · ${formatNumber(t.rowsA)} rows`) +
        item(`B: ${labelB}`, `${formatBytes(t.compressedB)} · ${formatNumber(t.rowsB)} rows`) +
        item('Δ compressed', formatDelta(t.delta, t.compressedA)) +
        `</div></div>`;
    const rgCard =
        `<div class="info-section regular-card"><h5 class="info-section-title">Row Group Totals</h5>` +
        `<div class="info-grid">` +
        diff.rowGroups
            .map(rg =>
                item(
                    `rg ${rg.rowGroup}`,
                    `${formatBytes(rg.compressedA)} → ${formatBytes(rg.compressedB)} ` +
                        `(${formatDelta(rg.delta, rg.compressedA)}) · rows ` +
                        `${formatNumber(rg.rowsA)} → ${formatNumber(rg.rowsB)}`
                )
            )
            .join('') +
        `</div></div>`;
    return `<div class="info-sections diff-summary">${fileCard}${rgCard}</div>`;
}

function unmatchedLines(diff: FileDiff): string {
    const line = (cls: string, label: string, paths: string[]): string =>
        paths.length === 0
            ? ''
            : `<p class="diff-unmatched ${cls}">${escapeHtml(label)} ` +
              `<span class="diff-col">${escapeHtml(paths.join(', '))}</span></p>`;
    return (
        line('diff-removed', 'Only in file A (removed):', diff.removed) +
        line('diff-added', 'Only in file B (added):', diff.added)
    );
}

/** Render the full diff view into `container` (replaces its content). */
export function renderDiffView(
    container: HTMLElement,
    diff: FileDiff,
    labelA: string,
    labelB: string
): void {
    container.innerHTML =
        totalsCards(diff, labelA, labelB) +
        `<div class="diff-table-wrap"><table class="diff-table">` +
        `<thead><tr><th class="diff-num">RG</th><th>Column</th>` +
        `<th class="diff-num" title="compressed size in A">Size A</th>` +
        `<th class="diff-num" title="compressed size in B">Size B</th>` +
        `<th class="diff-num diff-delta-header" title="Click to sort by delta">Δ compressed</th>` +
        `<th>Codec</th><th>Encodings</th></tr></thead>` +
        `<tbody></tbody></table></div>` +
        unmatchedLines(diff);

    const tbody = container.querySelector('tbody')!;
    const header = container.querySelector<HTMLElement>('.diff-delta-header')!;

    // null = structural order (as diffed); clicks toggle desc ↔ asc by delta.
    let ascending: boolean | null = null;
    const renderRows = (): void => {
        const rows = [...diff.chunks];
        if (ascending !== null) {
            rows.sort((x, y) => (ascending ? x.delta - y.delta : y.delta - x.delta));
        }
        tbody.innerHTML = rows.map(chunkRow).join('');
        header.classList.toggle('diff-sort-asc', ascending === true);
        header.classList.toggle('diff-sort-desc', ascending === false);
    };
    header.addEventListener('click', () => {
        ascending = ascending === false;
        renderRows();
    });
    renderRows();
}
