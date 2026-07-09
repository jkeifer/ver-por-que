/**
 * Pure rendering for the bloom-filter probe card: a 256-bit block as an 8×32
 * bit grid, the block-strip slot inner (label + grid), the value→hash→block
 * lineage line, and the whole-filter density strip (which doubles as the block
 * strip's scrollbar). No DOM, no state — the widget in `bloom-probe-widget.ts`
 * owns the element and drives these.
 */
import { formatNumber } from '../../format';
import type {
    BloomDensityResult,
    BloomProbeBit,
    BloomProbeResult,
} from '../../js/worker/pyodide-parquet';

/**
 * A 256-bit block as an 8×32 bit grid (rows = words, columns = bits) from its
 * raw 32 bytes. When `probed` is given (the block the probe landed in, being
 * viewed), the eight checked bits are marked hit (set) or miss (unset); every
 * other cell shows the block's actual contents dimly for texture. All hits ⟹
 * "might contain"; a single miss is exact proof of absence. Viewing a different
 * block (no `probed`) shows its plain bits.
 */
function renderBloomBlock(bytes: Uint8Array, cell: number, probed?: BloomProbeBit[]): string {
    if (bytes.length < 32) {
        return '';
    }
    const probedBit = new Map((probed ?? []).map(b => [b.word, b.bit]));
    const CELL = cell;
    const STEP = CELL + 1;
    const width = 32 * STEP - 1;
    const height = 8 * STEP - 1;
    let cells = '';
    for (let word = 0; word < 8; word++) {
        // Each word is a little-endian uint32; bit `col` is (word >> col) & 1.
        const value =
            (bytes[word * 4]! |
                (bytes[word * 4 + 1]! << 8) |
                (bytes[word * 4 + 2]! << 16) |
                (bytes[word * 4 + 3]! << 24)) >>>
            0;
        for (let col = 0; col < 32; col++) {
            const set = (value >>> col) & 1;
            const cls =
                probedBit.get(word) === col
                    ? set
                        ? 'bloom-bit-hit'
                        : 'bloom-bit-miss'
                    : set
                      ? 'bloom-bit-on'
                      : 'bloom-bit-off';
            cells +=
                `<rect class="${cls}" x="${col * STEP}" y="${word * STEP}" ` +
                `width="${CELL}" height="${CELL}" rx="1"/>`;
        }
    }
    return (
        `<svg class="bloom-block" viewBox="0 0 ${width} ${height}" width="${width}" ` +
        `height="${height}" role="img" aria-label="bloom-filter block">${cells}</svg>`
    );
}

/**
 * The inner contents of one block slot in the scroll strip: a small "block N"
 * index label over its 8×32 bit-grid at `cell` px per bit. `probed` (given only
 * for the probed block) marks the eight checked bits hit/miss AND flags the
 * label, so the lineage's "block X" has a visible referent. Missing bytes render
 * a placeholder of the same footprint, so filling a slot never reflows the row.
 * The `.bloom-block-cell` wrapper (with its `data-block`) is created in JS so a
 * slot can be filled in place without re-creating its observed element.
 */
export function blockCellInner(
    index: number,
    bytes: Uint8Array | null,
    cell: number,
    probed?: BloomProbeBit[]
): string {
    const isProbed = probed !== undefined;
    const label =
        `<div class="bloom-block-label${isProbed ? ' probed' : ''}">block ${formatNumber(index)}` +
        `${isProbed ? ' · probed' : ''}</div>`;
    const side = 32 * (cell + 1) - 1;
    const grid =
        bytes && bytes.length >= 32
            ? renderBloomBlock(bytes, cell, probed)
            : `<div class="bloom-block-placeholder" style="width:${side}px;height:${8 * (cell + 1) - 1}px"></div>`;
    return label + grid;
}

/** The value → hash → block lineage line shown above the probed block's grid. */
export function renderBloomLineage(res: BloomProbeResult): string {
    const hits = res.bits.filter(b => b.set).length;
    return (
        `<div class="bloom-lineage">hash <code>0x${res.hash}</code> → block ` +
        `${formatNumber(res.blockIndex)} of ${formatNumber(res.numBlocks)} · ${hits}/8 bits set` +
        `</div>`
    );
}

/** Estimated false-positive rate as a human `~X% est.` label. A split-block
 *  bloom filter checks 8 bits, so p(all set at random) ≈ fill**8; tiny values
 *  read as exponential rather than a wall of zeros, and 0 fill reads `~0%`. */
function estimatedFprLabel(fill: number): string {
    const fpr = fill ** 8;
    if (fpr <= 0) {
        return '~0%';
    }
    const pct = fpr * 100;
    const shown = pct < 0.001 ? `${pct.toExponential(1)}` : `${pct.toPrecision(2)}`;
    return `~${shown}%`;
}

/** The first block a strip cell maps to: cell index directly when one cell is
 *  one block (≤512), else the first block of the cell's contiguous bucket. */
function cellBlock(density: BloomDensityResult, cell: number): number {
    const n = density.buckets.length;
    return density.numBlocks <= n ? cell : Math.floor((cell * density.numBlocks) / n);
}

/**
 * The whole filter as a horizontal density heatmap: one rect per bucket, filled
 * by its set-bit fraction over a light track (empty reads empty). It doubles as
 * the block strip's scrollbar — a `.bloom-strip-viewport` box (positioned in JS
 * from scrollLeft) marks the visible window, and pressing/dragging the strip
 * scrubs it. The probed block's cell gets an inset outline (via CSS class). A
 * one-line readout pairs the overall fill %, block count, and est FPR.
 */
export function renderBloomStrip(density: BloomDensityResult, probedBlock?: number): string {
    const { buckets, fill, numBlocks } = density;
    const n = buckets.length;
    if (n === 0) {
        return `<div class="bloom-strip-readout">empty filter — 0 blocks</div>`;
    }
    const CELL = Math.max(1, Math.floor(512 / n));
    const height = 24;
    const width = n * CELL;
    const rects = buckets
        .map((b, i) => {
            const block = cellBlock(density, i);
            const marks = probedBlock !== undefined && block === probedBlock ? ' probed' : '';
            // Density carries as fill-opacity on the accent-filled cell (CSS
            // var() doesn't resolve in an SVG presentation attribute, so the
            // color lives in the class and only the opacity is inline); clamp so
            // a faint but non-empty bucket still reads as set.
            const alpha = b === 0 ? 0 : Math.max(0.08, b);
            return (
                `<rect class="bloom-strip-cell${marks}" data-block="${block}" ` +
                `x="${i * CELL}" y="0" width="${CELL}" height="${height}" ` +
                `fill-opacity="${alpha.toFixed(3)}"/>`
            );
        })
        .join('');
    const readout =
        `<div class="bloom-strip-readout">` +
        `<span>${(fill * 100).toFixed(1)}% full;</span>` +
        `<span>${formatNumber(numBlocks)} block${numBlocks === 1 ? '' : 's'};</span>` +
        `<span title="estimated false-positive rate (fill^8)">estimated false-positive rate ${estimatedFprLabel(fill)}</span>` +
        `</div>`;
    // The viewport box starts full-width; syncViewport repositions it from
    // scrollLeft as soon as the strip mounts. Drawn last so it sits over cells.
    const viewport = `<rect class="bloom-strip-viewport" x="0" y="0" width="${width}" height="${height}" rx="2"/>`;
    return (
        `<svg class="bloom-strip" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
        `preserveAspectRatio="none" role="img" aria-label="bloom-filter density">` +
        `<rect class="bloom-strip-track" x="0" y="0" width="${width}" height="${height}"/>${rects}${viewport}</svg>` +
        readout
    );
}
