/**
 * Pure rendering for the value/dictionary preview cards: a single value cell
 * (NULL, ellipsized long values, WKB geometry summaries with copy buttons), the
 * paged table windows, and the codec-unavailable note. The interactive sections
 * in the manager fetch windows and hand them here to render.
 */
import { formatNumber } from '../../format';
import { base64Bytes } from '../../business/stat-values';
import { describeWkb } from '../../business/wkb';
import type { DictionaryEntry, PreviewEntry, PreviewValue } from '../../js/worker/pyodide-parquet';
import { copyButton, copyGeoJsonButton, copyPhysicalButton, escapeHtml } from './view';

/** Long values are cut with an ellipsis in the preview list. */
const PREVIEW_VALUE_MAX_CHARS = 80;

/** Friendly (not an error state) message for a codec with no in-browser decoder. */
export function renderPreviewFailure(codec: string): string {
    const name = escapeHtml(codec);
    return (
        `<div class="value-preview-codec-note">This chunk is ${name}-compressed and ` +
        `${name.toLowerCase()} can't be decoded in-browser.</div>`
    );
}

/**
 * A single value cell: NULL is explicit; long values ellipsize with a copy
 * button for the full value. A GEOMETRY/GEOGRAPHY cell (raw WKB as base64) is
 * shown as a summary with a copy button that yields the full GeoJSON geometry;
 * WKB that won't parse falls back to the plain-string path (never mangled). When
 * a `physical` value is given (a logical column displays a converted value), a
 * second button copies the raw physical value the bloom probe hashes.
 */
function previewValueCell(value: PreviewValue, isWkb = false, physical?: PreviewValue): string {
    if (value === null) {
        return '<span class="value-preview-null">NULL</span>';
    }
    if (isWkb && typeof value === 'string') {
        const bytes = base64Bytes(value);
        const summary = bytes && describeWkb(bytes);
        if (summary) {
            // Carry the base64 WKB, not the GeoJSON; convert on click (see button).
            // GeoJSON (⧉) = the converted geometry; physical (#) = the raw base64
            // WKB the bloom probe hashes.
            return escapeHtml(summary) + copyGeoJsonButton(value) + copyPhysicalButton(value);
        }
    }
    const physicalBtn =
        physical === undefined || physical === null ? '' : copyPhysicalButton(String(physical));
    const s = String(value);
    if (s.length > PREVIEW_VALUE_MAX_CHARS) {
        return (
            escapeHtml(`${s.slice(0, PREVIEW_VALUE_MAX_CHARS - 1)}…`) + copyButton(s) + physicalBtn
        );
    }
    return escapeHtml(s) + physicalBtn;
}

/** tbody rows; `#` is each value's own absolute page index (sparse under null-skip). */
function renderPreviewRows(entries: PreviewEntry[], isWkb: boolean): string {
    return entries
        .map(
            entry =>
                `<tr><td class="value-preview-index">${entry.index}</td>` +
                `<td class="value-preview-value">${previewValueCell(entry.value, isWkb, entry.physical)}</td>` +
                `<td class="value-preview-level">${entry.def}</td>` +
                `<td class="value-preview-level">${entry.rep}</td></tr>`
        )
        .join('');
}

/** One rendered window plus the controls that drive it. */
export interface PreviewWindowView {
    entries: PreviewEntry[];
    /** Value index this window's span starts at (the requested offset). */
    start: number;
    /** Value index the next window starts at (one past this span). */
    next: number;
    total: number;
    nulls: number;
    hideNulls: boolean;
    canPrev: boolean;
    /** Column is WKB geometry: cells show a summary + copy-as-GeoJSON. */
    isWkb: boolean;
    onToggleNulls: (hide: boolean) => void;
    onPrev: () => void;
    onNext: () => void;
}

/** "1–100 of 5,000 values" window-range label (empty page reads "0 values"). */
function previewRange(start: number, next: number, total: number): string {
    return total === 0
        ? '0 values'
        : `${formatNumber(start + 1)}–${formatNumber(next)} of ${formatNumber(total)} ` +
              `value${total === 1 ? '' : 's'}`;
}

/** Prev/Next pager buttons, or '' when neither direction is available. */
function pagerButtons(canPrev: boolean, canNext: boolean): string {
    if (!canPrev && !canNext) {
        return '';
    }
    return (
        `<div class="value-preview-buttons">` +
        `<button type="button" class="btn btn-sm value-preview-prev"${canPrev ? '' : ' disabled'}>‹ Prev</button>` +
        `<button type="button" class="btn btn-sm value-preview-next"${canNext ? '' : ' disabled'}>Next ›</button></div>`
    );
}

/**
 * Fills `result` with one window of a page's values (scrollable table, frozen
 * header, zebra rows) and a footer that pairs the range/count text and the
 * "hide nulls" toggle with the prev/next pager. Callers keep the current table
 * in place until this swaps it in, so paging never flashes. The range spans the
 * value indices this window consumed (`start`..`next`), which under null-skip
 * can be far wider than the handful of rows shown.
 */
export function renderPreviewWindow(result: HTMLElement, view: PreviewWindowView): void {
    const { entries, start, next, total, nulls, hideNulls } = view;
    const range = previewRange(start, next, total);
    const info = nulls > 0 ? `${range} · ${formatNumber(nulls)} null` : range;
    const toggle =
        nulls > 0
            ? `<label class="value-preview-filter">` +
              `<input type="checkbox" class="value-preview-hide-nulls"${hideNulls ? ' checked' : ''}> ` +
              `hide nulls</label>`
            : '';
    result.innerHTML =
        `<div class="value-preview-table-wrap"><table class="value-preview-table">` +
        `<thead><tr><th>#</th><th>Value</th><th title="definition level">def</th>` +
        `<th title="repetition level">rep</th></tr></thead>` +
        `<tbody>${renderPreviewRows(entries, view.isWkb)}</tbody></table></div>` +
        `<div class="value-preview-pager">` +
        `<div class="value-preview-info"><span class="value-preview-range">${info}</span>${toggle}</div>` +
        `${pagerButtons(view.canPrev, next < total)}</div>`;
    result
        .querySelector<HTMLInputElement>('.value-preview-hide-nulls')
        ?.addEventListener('change', e =>
            view.onToggleNulls((e.target as HTMLInputElement).checked)
        );
    result.querySelector('.value-preview-prev')?.addEventListener('click', () => view.onPrev());
    result.querySelector('.value-preview-next')?.addEventListener('click', () => view.onNext());
}

/**
 * One window of dictionary entries as a `# | Value` table with a pager. Simpler
 * than renderPreviewWindow: a dictionary has no def/rep levels and no nulls, so
 * no level columns and no hide-nulls toggle, and paging is plain arithmetic.
 */
export function renderDictionaryWindow(
    result: HTMLElement,
    view: {
        entries: DictionaryEntry[];
        start: number;
        next: number;
        total: number;
        canPrev: boolean;
        isWkb: boolean;
        onPrev: () => void;
        onNext: () => void;
    }
): void {
    const rows = view.entries
        .map(
            e =>
                `<tr><td class="value-preview-index">${e.index}</td>` +
                `<td class="value-preview-value">${previewValueCell(e.value, view.isWkb)}</td></tr>`
        )
        .join('');
    result.innerHTML =
        `<div class="value-preview-table-wrap"><table class="value-preview-table">` +
        `<thead><tr><th>#</th><th>Value</th></tr></thead>` +
        `<tbody>${rows}</tbody></table></div>` +
        `<div class="value-preview-pager">` +
        `<div class="value-preview-info"><span class="value-preview-range">` +
        `${previewRange(view.start, view.next, view.total)}</span></div>` +
        `${pagerButtons(view.canPrev, view.next < view.total)}</div>`;
    result.querySelector('.value-preview-prev')?.addEventListener('click', () => view.onPrev());
    result.querySelector('.value-preview-next')?.addEventListener('click', () => view.onNext());
}
