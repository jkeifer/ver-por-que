/**
 * Shared info-panel view primitives: HTML escaping, the Row/Section value types
 * every panel is built from, and the copy-to-clipboard buttons. Imported across
 * the rendering modules so the panel speaks one vocabulary for cells, sections,
 * and copy payloads.
 */

/** A label/value row. An optional third element is a copy payload: a plain
 *  string (the full value, when truncated), `{ wkb }` base64 to copy as GeoJSON
 *  (converted lazily on click), or `{ physical }` — the raw physical value a
 *  logical column displays converted, for pasting into the bloom probe. */
export type Row =
    | [string, string | number]
    | [string, string | number, string]
    | [string, string | number, { wkb: string }]
    | [string, string | number, { physical: string }];

/** One rendered card: either a label/value grid (`rows`) or raw `html`. */
export interface Section {
    title: string;
    rows?: Row[];
    html?: string;
    degraded?: 'metadata-only';
}

export function escapeHtml(text: string): string {
    return text.replace(
        /[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
    );
}

/** A copy-to-clipboard button carrying the full (untruncated) value. `glyph` is
 *  a trusted literal (the button face), never user input. */
export function copyButton(full: string, label = 'Copy full value', glyph = '⧉'): string {
    return (
        `<button type="button" class="copy-btn" data-copy="${escapeHtml(full)}"` +
        ` title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${glyph}</button>`
    );
}

/** Copy button for the raw physical value a logical column displays converted
 *  (a temporal type's int, ...) — the value the bloom probe hashes. `#` sets it
 *  apart from the `⧉` value/GeoJSON copies at a glance. */
export function copyPhysicalButton(value: string): string {
    return copyButton(value, 'Copy physical value', '#');
}

/**
 * Copy button that holds base64 WKB and converts it to GeoJSON on click. A
 * preview page can hold 100 large geometries, so embedding each one's GeoJSON
 * up front would put megabytes in the DOM; convert lazily instead.
 */
export function copyGeoJsonButton(base64Wkb: string): string {
    return (
        `<button type="button" class="copy-btn" data-copy-wkb="${escapeHtml(base64Wkb)}"` +
        ` title="Copy as GeoJSON" aria-label="Copy as GeoJSON">⧉</button>`
    );
}

/** Truncate for display, returning `[shown, full]` where full is set only when clipped. */
export function truncateCopy(full: string, max: number): [string, string?] {
    return full.length > max ? [`${full.slice(0, max - 3)}...`, full] : [full];
}
