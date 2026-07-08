/**
 * Treemap lens: a size-proportional view over the SAME segment tree the byte
 * layout renders. Node area ∝ (end - start), laid out by the pure squarify
 * function. One level at a time: clicking a node with children drills into it
 * (the breadcrumb climbs back out); clicking a leaf selects it in place. Both
 * feed the same selection callback and info panel the byte-layout lens uses.
 */
import { formatBytes } from '../format';
import { VisualizationConfig } from '../config/visualization-config';
import { squarify } from '../business/treemap-layout';
import { distributeWithMinimums, type MinSizingOpts } from '../business/min-sizing';
import { describe, findPath, type SegmentNode } from '../business/segment-tree';
import type { AnyDump } from '../types';
import type { InfoPanelManager } from './info-panel-manager';
import type { Visualizer } from './visualizer';

const HEIGHT = 400;
// ponytail: min-sizing knobs in area (px²) so tiny metadata stays visible next
// to huge data nodes. Tuning knob — bump baseline/cap by eye if metadata is
// still too small (or too pushy) on real dumps.
const TREEMAP_MIN_SIZING: MinSizingOpts = {
    baseline: 400, // ~20×20 px smallest floor
    cap: 3600, // ~60×60 px largest floor
    floor: 64,
    logFactor: 2,
};
/** Rects narrower/shorter than this skip their label (heuristic, no measuring). */
const LABEL_MIN_HEIGHT = 18;
const LABEL_CHAR_WIDTH = 7.5;
const LABEL_PADDING = 8;

export class TreemapVisualizer implements Visualizer {
    private container: HTMLElement;
    private infoPanelManager: InfoPanelManager | null;

    private dump: AnyDump | null = null;
    private root: SegmentNode | null = null;
    /** Drill path from the root; the treemap shows the last node's children. */
    private path: SegmentNode[] = [];
    /** Selected childless node at the current level (drilled parents live in the path). */
    private selectedLeafId: string | null = null;
    /** Node ids whose rects render dimmed (query-pruned segments). */
    private dimmedIds = new Set<string>();

    private svg: SVGSVGElement | null = null;
    private resizeTimeout?: ReturnType<typeof setTimeout>;
    private onResize = (): void => {
        clearTimeout(this.resizeTimeout);
        this.resizeTimeout = setTimeout(() => this.render(), 100);
    };

    onSelectionChange: ((id: string | null) => void) | null = null;

    constructor(container: HTMLElement, infoPanelManager: InfoPanelManager | null = null) {
        this.container = container;
        this.infoPanelManager = infoPanelManager;
        window.addEventListener('resize', this.onResize);
    }

    initWithData(data: AnyDump, tree: SegmentNode): void {
        this.dump = data;
        this.root = tree;
        this.path = [this.root];
        this.selectedLeafId = null;
        this.render();
        if (this.infoPanelManager) {
            this.infoPanelManager.show(this.root, data);
        }
    }

    selectNodeById(id: string): boolean {
        if (!this.root) {
            return false;
        }
        const nodePath = findPath(this.root, id);
        if (!nodePath || nodePath.length < 2) {
            return false;
        }
        const node = nodePath[nodePath.length - 1]!;
        if (node.children.length > 0) {
            this.path = nodePath;
            this.selectedLeafId = null;
        } else {
            this.path = nodePath.slice(0, -1);
            this.selectedLeafId = node.id;
        }
        this.render();
        this.onSelectionChange?.(node.id);
        if (this.infoPanelManager && this.dump) {
            this.infoPanelManager.show(node, this.dump);
        }
        return true;
    }

    setDimmed(ids: Set<string>): void {
        this.dimmedIds = ids;
        this.svg?.querySelectorAll('.segment').forEach(rect => {
            rect.classList.toggle(
                'segment-dimmed',
                this.dimmedIds.has(rect.getAttribute('data-segment-id')!)
            );
        });
    }

    destroy(): void {
        window.removeEventListener('resize', this.onResize);
        clearTimeout(this.resizeTimeout);
    }

    private handleNodeClick(node: SegmentNode): void {
        if (node.children.length > 0) {
            this.path = [...this.path, node];
            this.selectedLeafId = null;
        } else if (this.selectedLeafId === node.id) {
            this.selectedLeafId = null; // clicking the selected page deselects it
        } else {
            this.selectedLeafId = node.id;
        }
        this.render();
        // Deselecting falls back to the current level (the drilled parent).
        const active = this.selectedLeafId ? node : this.path[this.path.length - 1]!;
        this.onSelectionChange?.(active === this.root ? null : active.id);
        if (this.infoPanelManager && this.dump) {
            this.infoPanelManager.show(active, this.dump);
        }
    }

    private handleBreadcrumbClick(index: number): void {
        this.path = this.path.slice(0, index + 1);
        this.selectedLeafId = null;
        this.render();
        const node = this.path[this.path.length - 1]!;
        this.onSelectionChange?.(node === this.root ? null : node.id);
        if (this.infoPanelManager && this.dump) {
            this.infoPanelManager.show(node, this.dump);
        }
    }

    private render(): void {
        if (!this.root) {
            return;
        }
        this.container.innerHTML = '';
        this.container.appendChild(this.renderBreadcrumb());

        const width =
            this.container.getBoundingClientRect().width ||
            Math.min(window.innerWidth - 40, VisualizationConfig.LAYOUT.MAX_WIDTH);

        this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
        this.svg.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`);
        this.svg.setAttribute('preserveAspectRatio', 'xMidYMin meet');
        this.svg.classList.add('treemap');
        this.svg.style.cssText = `
            display: block;
            width: 100%;
            height: ${HEIGHT}px;
            background: var(--bg-secondary);
            border-radius: 4px;
        `;

        const current = this.path[this.path.length - 1]!;
        // Floor tiny nodes to a minimum area (same log-scaled min-sizing the byte
        // layout uses) before packing, so metadata survives huge data siblings.
        const sizes = current.children.map(c => c.end - c.start);
        const total = sizes.reduce((sum, s) => sum + Math.max(0, s), 0);
        const adjusted = distributeWithMinimums(sizes, total, width * HEIGHT, TREEMAP_MIN_SIZING);
        const rects = squarify(
            current.children.map((c, i) => ({ id: c.id, size: adjusted[i]!.extent })),
            { x: 0, y: 0, width, height: HEIGHT }
        );
        const byId = new Map(current.children.map((c, i) => [c.id, { node: c, index: i }]));
        for (const placed of rects) {
            if (placed.width <= 0 || placed.height <= 0) {
                continue; // zero-size node: nothing visible or clickable to draw
            }
            const { node, index } = byId.get(placed.id)!;
            this.renderNode(node, placed, index);
        }

        this.container.appendChild(this.svg);
    }

    private renderBreadcrumb(): HTMLDivElement {
        const crumb = document.createElement('div');
        crumb.className = 'treemap-breadcrumb';
        // The selected page (a leaf, not in the path) trails as a final crumb so
        // the drilled parent above it becomes clickable to deselect back to it.
        const leaf = this.selectedLeafId
            ? (this.path[this.path.length - 1]!.children.find(c => c.id === this.selectedLeafId) ??
              null)
            : null;
        const nodes = leaf ? [...this.path, leaf] : this.path;
        nodes.forEach((node, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'treemap-crumb';
            button.textContent = node === this.root ? 'FILE' : node.name;
            button.disabled = index === nodes.length - 1;
            button.addEventListener('click', () => this.handleBreadcrumbClick(index));
            crumb.appendChild(button);
            if (index < nodes.length - 1) {
                const sep = document.createElement('span');
                sep.className = 'treemap-crumb-sep';
                sep.textContent = '›';
                crumb.appendChild(sep);
            }
        });
        return crumb;
    }

    private renderNode(
        node: SegmentNode,
        placed: { x: number; y: number; width: number; height: number },
        index: number
    ): void {
        const { fillColor, contrastClass } = VisualizationConfig.resolveSegmentStyle(
            node.kind,
            index
        );

        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('class', contrastClass);

        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(placed.x));
        rect.setAttribute('y', String(placed.y));
        rect.setAttribute('width', String(placed.width));
        rect.setAttribute('height', String(placed.height));
        rect.setAttribute('fill', fillColor);
        rect.setAttribute('stroke', 'var(--bg-secondary)');
        rect.setAttribute('stroke-width', '1');
        rect.setAttribute('data-segment-id', node.id);
        const dimmed = this.dimmedIds.has(node.id) ? ' segment-dimmed' : '';
        const selected = this.selectedLeafId === node.id ? ' segment-selected' : '';
        rect.setAttribute('class', `segment ${contrastClass}${dimmed}${selected}`);
        rect.addEventListener('click', e => {
            e.stopPropagation();
            this.handleNodeClick(node);
        });

        // Native tooltip: the byte-layout lens uses a floating div; a <title>
        // carries the same facts with zero positioning code.
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        const label = describe(node);
        title.textContent =
            `${label}\n` +
            `Range: ${formatBytes(node.start)} - ${formatBytes(node.end)}\n` +
            `Size: ${formatBytes(node.end - node.start)}`;
        rect.appendChild(title);
        group.appendChild(rect);

        // ponytail: character-count heuristic instead of getBBox measuring;
        // swap in measurement if labels ever visibly overflow.
        const fits =
            placed.height >= LABEL_MIN_HEIGHT &&
            node.name.length * LABEL_CHAR_WIDTH <= placed.width - LABEL_PADDING;
        if (fits) {
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('x', String(placed.x + placed.width / 2));
            text.setAttribute('y', String(placed.y + placed.height / 2));
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('dominant-baseline', 'central');
            text.setAttribute('class', 'segment-label');
            text.textContent = node.name;
            group.appendChild(text);
        }

        this.svg!.appendChild(group);
    }
}
