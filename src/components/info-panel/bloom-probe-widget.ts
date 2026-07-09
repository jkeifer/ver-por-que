/**
 * The interactive bloom-filter probe card — a self-contained, virtualized
 * scroll widget. It owns everything the card needs: batched on-demand block
 * fetching (with in-flight dedup and a byte cache), a virtualized block strip
 * (only the visible window + a buffer is mounted, absolutely placed in a
 * full-width track), a density minimap that doubles as the strip's scrollbar
 * (drag/press to scrub), and the probe lifecycle (value → hash → block lineage,
 * hit/miss overlay, verdict). `createBloomProbeWidget` returns the element plus
 * a `destroy()` that disconnects the ResizeObserver — the manager calls it
 * before the panel is re-rendered or hidden so the observer never outlives the
 * strip. Pure rendering lives in `bloom-view`; this file is state + wiring.
 */
import { findSchemaLeaf, type SegmentNode } from '../../business/segment-tree';
import { base64Bytes, isBinaryLeaf, parsePredicateValue } from '../../business/stat-values';
import type {
    BloomDensityResult,
    BloomProbeBit,
    BloomProbeResult,
} from '../../js/worker/pyodide-parquet';
import type { AnyDump } from '../../types';
import type { BloomBlocks, BloomDensity, BloomProbe } from './capabilities';
import { blockCellInner, renderBloomLineage, renderBloomStrip } from './bloom-view';
import { reportWorkerError } from './recovery';
import type { RecoveryActions } from './recovery';

/** Worker capabilities + recovery the probe card needs. `bloomProbe` is always
 *  live (the manager only builds the card when it is); density/blocks share that
 *  lifecycle but are guarded individually, matching the pre-extraction flow. */
export interface BloomProbeDeps {
    bloomProbe: BloomProbe;
    bloomDensity: BloomDensity | null;
    bloomBlocks: BloomBlocks | null;
    recovery: RecoveryActions;
}

export interface BloomProbeWidget {
    element: HTMLElement;
    /** Disconnect the block strip's ResizeObserver. Safe to call more than once. */
    destroy(): void;
}

export function createBloomProbeWidget(
    node: Extract<SegmentNode, { kind: 'bloom_filter' }>,
    dump: AnyDump,
    deps: BloomProbeDeps
): BloomProbeWidget {
    const leaf = findSchemaLeaf(dump.metadata.schema_root, node.path);
    // Binary columns (geometry/UUID/raw binary) aren't typeable as text; the
    // probe takes base64 of the raw bytes and the worker decodes it.
    const binary = leaf ? isBinaryLeaf(leaf) : false;
    const section = document.createElement('div');
    section.className = 'info-section large-card bloom-probe-section';
    section.innerHTML =
        `<h5 class="info-section-title">Probe a Value</h5>` +
        `<div class="bloom-probe-controls">` +
        `<input type="text" class="bloom-probe-value" placeholder="${
            leaf ? `${leaf.type} value${binary ? ' (base64)' : ''}` : 'value'
        }">` +
        `<button type="button" class="btn btn-sm bloom-probe-btn">Probe</button>` +
        `<button type="button" class="btn btn-sm bloom-probe-clear" disabled>Clear</button>` +
        `</div>` +
        // Probe text up top so it correlates with the input and stays put
        // while the block strip scrolls elsewhere. One fixed-height status
        // area holds an explanatory hint until probed, then the lineage +
        // verdict — same reserved height either way, so nothing shifts.
        `<div class="bloom-probe-status"></div>` +
        `<div class="bloom-scroll"><div class="bloom-block-track"></div></div>` +
        // The density strip sits BELOW the block strip, reading as its
        // scrollbar (the viewport box is the thumb); the readout rides with it.
        `<div class="bloom-strip-wrap"></div>` +
        `<div class="bloom-probe-note"></div>`;
    const input = section.querySelector<HTMLInputElement>('.bloom-probe-value')!;
    const probeBtn = section.querySelector<HTMLButtonElement>('.bloom-probe-btn')!;
    const clearBtn = section.querySelector<HTMLButtonElement>('.bloom-probe-clear')!;
    const status = section.querySelector<HTMLElement>('.bloom-probe-status')!;
    const stripWrap = section.querySelector<HTMLElement>('.bloom-strip-wrap')!;
    const scroll = section.querySelector<HTMLElement>('.bloom-scroll')!;
    const track = section.querySelector<HTMLElement>('.bloom-block-track')!;
    const note = section.querySelector<HTMLElement>('.bloom-probe-note')!;

    // Fixed geometry: a block grid is 32*(CELL+1)-1 px wide; SLOT_W adds the
    // gap so block i sits at left = i*SLOT_W; SLOT_H bounds the track height.
    // BATCH is blocks per lazy range fetch; BUFFER over-renders each side of
    // the viewport so a scroll reveals ready grids.
    const CELL = 11;
    const BLOCK_W = 32 * (CELL + 1) - 1;
    const GAP = 12;
    const SLOT_W = BLOCK_W + GAP;
    const SLOT_H = 8 * (CELL + 1) - 1 + 23;
    const BATCH = 32;
    const BUFFER = 4;

    // Closure state: the fetched density, the last probe (null until probed),
    // a cache of fetched block bytes, the batch-start of each in-flight fetch
    // (dedupe), the currently-mounted window (so we re-render only on change),
    // the strip's <svg>/viewport-box refs (repositioned on scroll), and the
    // ResizeObserver re-virtualizing on width changes (destroy() disconnects it).
    let density: BloomDensityResult | null = null;
    let probe: BloomProbeResult | null = null;
    const blockCache = new Map<number, Uint8Array>();
    const inflight = new Set<number>();
    let renderedStart = -1;
    let renderedEnd = -1;
    let stripSvg: SVGSVGElement | null = null;
    let viewportRect: SVGRectElement | null = null;
    let observer: ResizeObserver | null = null;

    // A block's 32 bytes, or null when not yet available: the probed block
    // reads straight from the probe result; any other from the cache.
    const bytesFor = (block: number): Uint8Array | null => {
        if (probe && block === probe.blockIndex) {
            return base64Bytes(probe.block) ?? null;
        }
        return blockCache.get(block) ?? null;
    };
    const probeBits = (block: number): BloomProbeBit[] | undefined =>
        probe && block === probe.blockIndex ? probe.bits : undefined;

    // Paint a mounted slot in place (label + grid, hit/miss if probed); a
    // no-op when the block isn't in the current window.
    const fillSlot = (block: number): void => {
        const el = track.querySelector<HTMLElement>(`.bloom-block-cell[data-block="${block}"]`);
        if (el) {
            el.innerHTML = blockCellInner(block, bytesFor(block), CELL, probeBits(block));
        }
    };

    // Ensure `block`'s bytes are (being) fetched: one range read per aligned
    // BATCH, deduped by batch-start, filling each mounted slot as bytes land.
    const ensureFetched = (block: number): void => {
        if (!deps.bloomBlocks || !density || bytesFor(block)) {
            return;
        }
        const start = Math.floor(block / BATCH) * BATCH;
        if (inflight.has(start)) {
            return;
        }
        inflight.add(start);
        const count = Math.min(BATCH, density.numBlocks - start);
        deps.bloomBlocks(node.rowGroup, node.path, start, count).then(
            b64 => {
                inflight.delete(start);
                const decoded = base64Bytes(b64);
                if (!decoded) {
                    return;
                }
                for (let i = 0; i * 32 < decoded.length; i++) {
                    blockCache.set(start + i, decoded.subarray(i * 32, i * 32 + 32));
                    fillSlot(start + i);
                }
            },
            (error: unknown) => {
                inflight.delete(start);
                reportWorkerError(note, error, 'Blocks unavailable', deps.recovery);
            }
        );
    };

    // The fixed-height status area: an explanatory hint until a probe lands,
    // then the value→hash→block lineage and the verdict. Same reserved height
    // both ways, so revealing the result never shifts layout.
    const renderStatus = (): void => {
        if (!probe) {
            status.innerHTML =
                `<p class="bloom-probe-hint">A bloom filter can rule a value ` +
                `<em>out</em> of this row group. Type a value and Probe: the filter ` +
                `answers <strong>definitely not present</strong> — the reader safely ` +
                `skips the whole row group — or <strong>maybe present</strong>, which ` +
                `it can't rule out (bloom filters never give a false negative, only ` +
                `false positives). The block it hashes to lights up below.</p>`;
            return;
        }
        status.innerHTML =
            renderBloomLineage(probe) +
            `<div class="bloom-verdict bloom-verdict-${probe.mightContain ? 'maybe' : 'no'}">` +
            (probe.mightContain
                ? '<strong>maybe present</strong> — a bloom filter can only ever ' +
                  'answer “definitely not” or “maybe”; this could be a false positive.'
                : '<strong>definitely not present</strong> — the filter has no false ' +
                  'negatives, so a reader can safely skip this row group.') +
            `</div>`;
    };
    renderStatus();

    // Position the minimap's viewport box to mirror the visible window: the
    // box spans [scrollLeft, scrollLeft+clientWidth] as a fraction of the full
    // content, mapped into the strip's own coordinate width.
    const syncViewport = (): void => {
        if (!stripSvg || !viewportRect) {
            return;
        }
        const vbW = Number(stripSvg.getAttribute('width'));
        const full = scroll.scrollWidth;
        const view = scroll.clientWidth;
        const x = full > 0 ? (scroll.scrollLeft / full) * vbW : 0;
        const w = full > 0 ? Math.min(1, view / full) * vbW : vbW;
        viewportRect.setAttribute('x', x.toFixed(2));
        viewportRect.setAttribute('width', w.toFixed(2));
    };

    // Mount only the blocks in view (± BUFFER), absolutely placed in the
    // full-width track, re-rendering just on window change; each mounted
    // block kicks off its lazy fetch.
    const renderWindow = (): void => {
        if (!density) {
            return;
        }
        const first = Math.max(0, Math.floor(scroll.scrollLeft / SLOT_W) - BUFFER);
        const last = Math.min(
            density.numBlocks,
            Math.ceil((scroll.scrollLeft + scroll.clientWidth) / SLOT_W) + BUFFER
        );
        if (first === renderedStart && last === renderedEnd) {
            return;
        }
        renderedStart = first;
        renderedEnd = last;
        const cells: string[] = [];
        for (let i = first; i < last; i++) {
            cells.push(
                `<div class="bloom-block-cell" data-block="${i}" style="left:${i * SLOT_W}px">` +
                    `${blockCellInner(i, bytesFor(i), CELL, probeBits(i))}</div>`
            );
        }
        track.innerHTML = cells.join('');
        for (let i = first; i < last; i++) {
            ensureFetched(i);
        }
    };

    // Force the next renderWindow to rebuild (probe/clear changed the marks).
    const invalidate = (): void => {
        renderedStart = -1;
        renderedEnd = -1;
    };

    const onScroll = (): void => {
        renderWindow();
        syncViewport();
    };

    // Re-draw the overview strip (optionally marking the probed block) and
    // re-acquire the <svg>/box refs the strip owns, then reposition the box.
    const drawStrip = (probedBlock?: number): void => {
        if (!density) {
            return;
        }
        stripWrap.innerHTML = renderBloomStrip(density, probedBlock);
        stripSvg = stripWrap.querySelector<SVGSVGElement>('svg.bloom-strip');
        viewportRect = stripWrap.querySelector<SVGRectElement>('.bloom-strip-viewport');
        syncViewport();
    };

    // Scroll so `block` sits centered (browser clamps to the scroll range).
    const scrollToBlock = (block: number): void => {
        scroll.scrollLeft = block * SLOT_W - (scroll.clientWidth - BLOCK_W) / 2;
    };

    // The strip is the scrollbar: map a pointer x to a centered scroll pos.
    const scrubTo = (clientX: number): void => {
        if (!stripSvg) {
            return;
        }
        const rect = stripSvg.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        scroll.scrollLeft = frac * scroll.scrollWidth - scroll.clientWidth / 2;
        onScroll();
    };

    // Fetch the whole filter's density once, size the virtual track, draw the
    // strip, and mount the first window. A ResizeObserver re-virtualizes (and
    // repositions the box) when the card width changes.
    if (deps.bloomDensity) {
        stripWrap.textContent = 'Loading filter…';
        deps.bloomDensity(node.rowGroup, node.path).then(
            d => {
                density = d;
                track.style.width = `${d.numBlocks * SLOT_W - GAP}px`;
                track.style.height = `${SLOT_H}px`;
                drawStrip();
                onScroll();
                observer?.disconnect();
                observer = new ResizeObserver(onScroll);
                observer.observe(scroll);
            },
            (error: unknown) =>
                reportWorkerError(stripWrap, error, 'Filter unavailable', deps.recovery)
        );
    }

    scroll.addEventListener('scroll', onScroll);

    // Press/drag anywhere on the strip to scrub the block strip (the box is
    // pointer-transparent, so drags fall through to the density cells).
    let dragging = false;
    stripWrap.addEventListener('pointerdown', e => {
        if (!density) {
            return;
        }
        dragging = true;
        stripWrap.setPointerCapture(e.pointerId);
        scrubTo(e.clientX);
    });
    stripWrap.addEventListener('pointermove', e => {
        if (dragging) {
            scrubTo(e.clientX);
        }
    });
    const endDrag = (e: PointerEvent): void => {
        if (dragging) {
            dragging = false;
            stripWrap.releasePointerCapture(e.pointerId);
        }
    };
    stripWrap.addEventListener('pointerup', endDrag);
    stripWrap.addEventListener('pointercancel', endDrag);

    const run = (): void => {
        note.textContent = '';
        // Binary columns take base64 of the raw bytes; validate it decodes,
        // then send the trimmed base64 (the worker decodes it back to bytes).
        // Everything else parses as its typed value, same as the query panel.
        let value: string | undefined;
        if (binary) {
            const trimmed = input.value.trim();
            value = base64Bytes(trimmed) ? trimmed : undefined;
        } else {
            const parsed = leaf ? parsePredicateValue(input.value, leaf) : undefined;
            value = parsed === undefined ? undefined : String(parsed);
        }
        if (value === undefined) {
            note.textContent = leaf
                ? `'${input.value}' is not a valid ${leaf.type} value${
                      binary ? ' (expected base64)' : ''
                  }`
                : `column '${node.path}' was not found in the schema`;
            return;
        }
        note.textContent = 'Probing...';
        deps.bloomProbe(node.rowGroup, node.path, value).then(
            res => {
                probe = res;
                note.textContent = '';
                clearBtn.disabled = false;
                renderStatus();
                // Re-mark the strip, scroll the probed block into view, and
                // force the window to rebuild with its hit/miss overlay.
                drawStrip(res.blockIndex);
                scrollToBlock(res.blockIndex);
                invalidate();
                onScroll();
            },
            (error: unknown) => reportWorkerError(note, error, 'Probe failed', deps.recovery)
        );
    };
    probeBtn.addEventListener('click', run);
    clearBtn.addEventListener('click', () => {
        // Drop the probe overlay: unmark the strip and rebuild the window so
        // the previously-probed block repaints without its marks (fetching
        // its real bytes if they weren't cached).
        probe = null;
        clearBtn.disabled = true;
        note.textContent = '';
        renderStatus();
        drawStrip();
        invalidate();
        onScroll();
    });
    input.addEventListener('keypress', e => {
        if ((e as KeyboardEvent).key === 'Enter') {
            run();
        }
    });

    return {
        element: section,
        destroy: () => {
            observer?.disconnect();
            observer = null;
        },
    };
}
