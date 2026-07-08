/**
 * SVG-Based Byte Range Visualizer
 * Parquet file structure visualization with slide animations and drill-down.
 */
import { formatBytes } from '../format';
import { VisualizationConfig, type LayoutConfig } from '../config/visualization-config';
import {
    SegmentLayoutCalculator,
    type LevelLayout,
    type SegmentLayout,
} from '../business/segment-layout-calculator';
import { describe, findPath, type SegmentNode } from '../business/segment-tree';
import type { AnyDump } from '../types';
import { escapeHtml, type InfoPanelManager } from './info-panel-manager';
import { FunnelLayer } from './svg-funnels';
import type { Visualizer } from './visualizer';

export type FunnelElement = SVGElement & { labelElement?: SVGElement | null };
export type SegmentRect = SVGElement & { labelElement?: SVGElement | null };

export interface Level {
    name: string;
    parentSegmentId: string | null;
    segments: SegmentNode[];
    layout: LevelLayout;
    svgGroup: SVGGElement;
    animationState: 'appearing' | 'visible';
    funnelElement?: FunnelElement | null;
}

const ANIM_MS = 300;

export class SvgByteVisualizer implements Visualizer {
    private container: HTMLElement;
    private svg!: SVGSVGElement;
    private config: LayoutConfig;

    private dump: AnyDump | null = null;
    private root: SegmentNode | null = null;
    private levels: Level[] = [];
    private selectedSegments = new Map<number, string>();
    private selectionPath: SegmentNode[] = [];
    private hoveredSegment: string | null = null;
    /** Node ids whose rects render dimmed (query-pruned segments). */
    private dimmedIds = new Set<string>();

    private width = 0;
    private height = 0;

    /** Fired with the deepest selected node's id (null when nothing is selected). */
    onSelectionChange: ((id: string | null) => void) | null = null;

    private tooltip!: HTMLDivElement;
    private funnels!: FunnelLayer;
    private infoPanelManager: InfoPanelManager | null;
    private resizeTimeout?: ReturnType<typeof setTimeout>;

    // Bound once so they can be removed on destroy.
    private onResize = (): void => this.handleResize();
    private onKeyDown = (e: KeyboardEvent): void => this.handleKeyDown(e);

    constructor(
        container: HTMLElement,
        infoPanelManager: InfoPanelManager | null = null,
        config: LayoutConfig | null = null
    ) {
        this.container = container;
        this.config = config || VisualizationConfig.LAYOUT;
        this.infoPanelManager = infoPanelManager;
        this.init();
    }

    private init(): void {
        this.createSVG();
        this.funnels = new FunnelLayer(
            this.svg,
            this.config,
            (tag, attrs) => this.createSvgElement(tag, attrs),
            () => this.width
        );
        this.setupEventListeners();
        this.createTooltip();
    }

    private createSVG(): void {
        this.container.innerHTML = '';
        this.svg = this.createSvgElement('svg', {
            width: '100%',
            style: `
                display: block;
                background: var(--bg-secondary);
                border-radius: 4px;
                cursor: pointer;
                height: ${this.calculateContentHeight()}px;
            `,
        }) as SVGSVGElement;

        this.container.appendChild(this.svg);
        this.updateSvgSize();
    }

    private createSvgElement(
        tag: string,
        attributes: Record<string, string | number> = {}
    ): SVGElement {
        const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.entries(attributes).forEach(([key, value]) => {
            if (key === 'style') {
                element.style.cssText = String(value);
            } else {
                element.setAttribute(key, String(value));
            }
        });
        return element;
    }

    private updateSvgSize(): void {
        const rect = this.svg.getBoundingClientRect();
        this.width = rect.width;
        this.height = rect.height;

        if (this.width === 0 || this.height === 0) {
            const containerRect = this.container.getBoundingClientRect();
            if (containerRect.width > 0) {
                this.width = containerRect.width;
                this.height = this.calculateContentHeight() || 80;
            } else {
                this.width = Math.min(window.innerWidth - 40, this.config.MAX_WIDTH || 1200);
                this.height = this.calculateContentHeight() || 80;
            }
        }

        this.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
        this.svg.setAttribute('preserveAspectRatio', 'xMidYMin meet');
    }

    private calculateContentHeight(): number {
        if (this.levels.length === 0) {
            return VisualizationConfig.LAYOUT.LEVEL_HEIGHT;
        }

        let maxY = 0;
        this.levels.forEach(level => {
            if (level.layout) {
                maxY = Math.max(maxY, level.layout.y + level.layout.height);
            }
        });

        return Math.max(VisualizationConfig.LAYOUT.LEVEL_HEIGHT, maxY);
    }

    private updateSvgHeight(): void {
        const newHeight = this.calculateContentHeight();
        if (this.height !== newHeight) {
            this.height = newHeight;
            this.svg.style.height = `${newHeight}px`;
            this.svg.setAttribute('viewBox', `0 0 ${this.width} ${newHeight}`);
        }
    }

    private animateSvgHeightChange(
        startHeight: number,
        endHeight: number,
        duration = ANIM_MS
    ): void {
        if (startHeight === endHeight) {
            return;
        }

        this.height = endHeight;
        this.svg.style.transition = `height ${duration}ms cubic-bezier(0.4, 0, 0.2, 1)`;
        this.svg.style.height = `${startHeight}px`;

        const isExpanding = endHeight > startHeight;
        if (!isExpanding) {
            this.svg.setAttribute('viewBox', `0 0 ${this.width} ${endHeight}`);
        }

        requestAnimationFrame(() => {
            this.svg.style.height = `${endHeight}px`;
        });

        setTimeout(() => {
            if (isExpanding) {
                this.svg.setAttribute('viewBox', `0 0 ${this.width} ${endHeight}`);
            }
            this.svg.style.transition = '';
        }, duration);
    }

    private setupEventListeners(): void {
        window.addEventListener('resize', this.onResize);
        document.addEventListener('keydown', this.onKeyDown);
    }

    private createTooltip(): void {
        const config = VisualizationConfig.TOOLTIP;
        this.tooltip = document.createElement('div');
        this.tooltip.className = 'svg-tooltip';
        this.tooltip.style.cssText = `
            position: absolute;
            background: rgba(0, 0, 0, 0.9);
            color: white;
            padding: 8px 12px;
            border-radius: 4px;
            font-size: 12px;
            line-height: 1.4;
            pointer-events: none;
            z-index: 1000;
            visibility: hidden;
            max-width: min(500px, calc(100vw - 20px));
            min-width: ${config.MIN_WIDTH}px;
            white-space: normal;
            word-wrap: break-word;
            box-sizing: border-box;
        `;
        document.body.appendChild(this.tooltip);
    }

    /** Initialize with parquet data and the shared, already-projected tree. */
    initWithData(data: AnyDump, tree: SegmentNode): void {
        this.dump = data;
        this.root = tree;
        this.levels = [];
        this.selectedSegments.clear();
        this.selectionPath = [];

        requestAnimationFrame(() => {
            this.updateSvgSize();

            this.addLevel('overview', null, this.root!.children);

            if (this.infoPanelManager && this.dump && this.root) {
                this.infoPanelManager.show(this.root, this.dump);
            }
        });
    }

    /**
     * Programmatically select a node by id, drilling down through its
     * ancestors exactly as if each were clicked. Returns false (a silent
     * no-op) when the id isn't in the tree — or is the root, which has no
     * clickable segment. Deferred one frame so initWithData's pending level-0
     * build lands first.
     */
    selectNodeById(id: string): boolean {
        if (!this.root) {
            return false;
        }
        const path = findPath(this.root, id);
        if (!path || path.length < 2) {
            return false;
        }
        requestAnimationFrame(() => {
            // Skip the unrendered root; each click selects at its level and
            // synchronously adds the next level, so the chain composes.
            path.slice(1).forEach((node, level) => this.handleSegmentClick(node, level));
        });
        return true;
    }

    private addLevel(
        levelName: string,
        parentSegmentId: string | null,
        segments: SegmentNode[]
    ): Level {
        const levelIndex = this.levels.length;
        const layout = this.computeLevelLayout(levelName, parentSegmentId, segments, levelIndex);
        const level: Level = {
            name: levelName,
            parentSegmentId: parentSegmentId,
            segments: segments || [],
            layout: layout,
            svgGroup: this.createLevelGroup(layout, levelIndex),
            animationState: 'appearing',
        };

        const currentHeight = this.calculateContentHeight();
        this.levels.push(level);
        const newHeight = this.calculateContentHeight();

        this.animateSlideDown(level, levelIndex);
        this.animateSvgHeightChange(currentHeight, newHeight, ANIM_MS);

        requestAnimationFrame(() => this.updateSelectionDisplay());

        return level;
    }

    private createLevelGroup(layout: LevelLayout, levelIndex: number): SVGGElement {
        const group = this.createSvgElement('g', {
            class: `level level-${levelIndex}`,
            'data-level': layout.levelName,
            'data-level-index': levelIndex,
            transform: `translate(0, ${layout.y})`,
        }) as SVGGElement;

        this.renderSegments(group, layout.segments, levelIndex);

        return group;
    }

    /** Render each segment of a level into `target`, shaded by its position. */
    private renderSegments(
        target: SVGGElement,
        segments: SegmentLayout[],
        levelIndex: number
    ): void {
        // Opaque backing over the segment rows: dimmed (query-pruned) rects drop
        // to opacity 0.2, so without this they'd composite over — and reveal —
        // the child level sliding underneath them during a fold. Painted first
        // (so it sits behind this level's segments but above the funnels), it
        // gives the 0.2 rects an opaque backdrop: the dim still reads as a fade
        // over the page background, but the child stays hidden.
        if (segments.length > 0) {
            const top = Math.min(...segments.map(s => s.y));
            const bottom = Math.max(...segments.map(s => s.y + s.height));
            target.appendChild(
                this.createSvgElement('rect', {
                    x: 0,
                    y: top,
                    width: this.width,
                    height: bottom - top,
                    fill: 'var(--bg-secondary)',
                    class: 'level-backing',
                    'pointer-events': 'none',
                })
            );
        }
        segments.forEach((segmentLayout, segmentIndex) => {
            this.createSegmentElements(segmentLayout, target, levelIndex, segmentIndex);
        });
    }

    private createSegmentElements(
        segmentLayout: SegmentLayout,
        group: SVGGElement,
        levelIndex: number,
        segmentIndex: number
    ): void {
        const segment = segmentLayout.segment;

        const { fillColor, contrastClass } = VisualizationConfig.resolveSegmentStyle(
            segment.kind,
            segmentIndex
        );

        const segmentGroup = this.createSvgElement('g', { class: contrastClass });

        const rect = this.createSvgElement('rect', {
            x: segmentLayout.x,
            y: segmentLayout.y,
            width: segmentLayout.width,
            height: segmentLayout.height,
            fill: fillColor,
            rx: this.config.CORNER_RADIUS || 0,
            class: `segment ${contrastClass}${this.dimmedIds.has(segment.id) ? ' segment-dimmed' : ''}`,
            'data-segment-id': segment.id,
            'data-level-index': levelIndex,
        }) as SegmentRect;

        this.setupSegmentEventListeners(rect, segment, levelIndex);
        segmentGroup.appendChild(rect);

        const centerX = segmentLayout.x + segmentLayout.width / 2;
        const centerY = segmentLayout.y + segmentLayout.height / 2;

        const text = this.createSvgElement('text', {
            x: centerX,
            y: centerY,
            'text-anchor': 'middle',
            'dominant-baseline': 'central',
            'font-family': 'var(--font-sans)',
            'font-size': '12px',
            class: 'segment-label',
            'pointer-events': 'none',
            style: 'user-select: none;',
        });

        text.textContent = segment.name;
        segmentGroup.appendChild(text);
        group.appendChild(segmentGroup);

        requestAnimationFrame(() => {
            const textBBox = (text as SVGGraphicsElement).getBBox();
            const availableWidth = segmentLayout.width - 8;

            if (textBBox.width <= availableWidth) {
                rect.labelElement = text;
            } else {
                text.remove();
            }
        });
    }

    private setupSegmentEventListeners(
        rect: SVGElement,
        segment: SegmentNode,
        levelIndex: number
    ): void {
        rect.addEventListener('mouseenter', (e: MouseEvent) => {
            this.hoveredSegment = segment.id;
            if (!this.isSegmentSelected(segment.id, levelIndex)) {
                rect.classList.add('segment-hover');
            }
            this.showSegmentTooltip(e, segment);
        });

        rect.addEventListener('mouseleave', () => {
            this.hoveredSegment = null;
            rect.classList.remove('segment-hover');
            this.hideTooltip();
        });

        rect.addEventListener('mousemove', (e: MouseEvent) => {
            if (this.hoveredSegment === segment.id) {
                this.updateTooltipPosition(e);
            }
        });

        rect.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            this.handleSegmentClick(segment, levelIndex);
        });
    }

    private computeLevelLayout(
        levelName: string,
        parentSegmentId: string | null,
        segments: SegmentNode[],
        levelIndex: number
    ): LevelLayout {
        return SegmentLayoutCalculator.computeLevelLayout(
            levelName,
            parentSegmentId,
            segments,
            levelIndex,
            this.width,
            this.config
        );
    }

    private animateSlideDown(level: Level, levelIndex: number): void {
        const group = level.svgGroup;
        const parentLevel = this.findParentLevel(level);

        let startY = level.layout.y;
        if (parentLevel) {
            startY = parentLevel.layout.y;
        }

        if (parentLevel && level.parentSegmentId) {
            this.funnels.createAnimatedFunnel(
                level,
                levelIndex,
                parentLevel,
                startY,
                level.layout.y
            );
        }

        group.setAttribute('transform', `translate(0, ${startY})`);
        group.style.transition = 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1)';

        if (parentLevel && parentLevel.svgGroup) {
            this.svg.insertBefore(group, parentLevel.svgGroup);
        } else {
            this.svg.appendChild(group);
        }

        requestAnimationFrame(() => {
            group.setAttribute('transform', `translate(0, ${level.layout.y})`);
        });

        setTimeout(() => {
            level.animationState = 'visible';
        }, ANIM_MS);
    }

    private removeLevelsFrom(index: number): void {
        if (index >= this.levels.length) {
            return;
        }

        const levelsToRemove = this.levels.slice(index);
        if (levelsToRemove.length === 0) {
            return;
        }

        const currentHeight = this.calculateContentHeight();
        this.levels = this.levels.slice(0, index);
        const newHeight = this.calculateContentHeight();

        const totalAnimationTime = ANIM_MS + levelsToRemove.length * 50;
        this.animateSvgHeightChange(currentHeight, newHeight, totalAnimationTime);

        levelsToRemove.reverse().forEach((level, i) => {
            setTimeout(() => {
                this.animateSlideUp(level);
            }, i * 50);
        });
    }

    /**
     * Slide a level up and remove it. When `explicitParent` is undefined the
     * parent is looked up in the current levels; pass an explicit parent (which
     * may live in a batch being removed) to preserve funnel positioning.
     */
    private animateSlideUp(level: Level, explicitParent?: Level | null): void {
        const group = level.svgGroup;
        if (!group) {
            return;
        }

        const parentLevel =
            explicitParent !== undefined ? explicitParent : this.findParentLevel(level);

        if (parentLevel && parentLevel.svgGroup) {
            this.svg.insertBefore(group, parentLevel.svgGroup);
        }

        let targetY = level.layout.y;
        if (parentLevel) {
            targetY = parentLevel.layout.y;
        } else {
            targetY = -level.layout.height - 50;
        }

        if (level.funnelElement && parentLevel) {
            this.funnels.animateFunnelSlideUp(level, parentLevel, targetY);
        }

        group.style.transition = 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1)';

        requestAnimationFrame(() => {
            group.setAttribute('transform', `translate(0, ${targetY})`);
        });

        setTimeout(() => {
            if (group.parentNode) {
                group.parentNode.removeChild(group);
            }
            this.funnels.removeFunnel(level);
        }, ANIM_MS);
    }

    private handleSegmentClick(segment: SegmentNode, levelIndex: number): void {
        const isCurrentlySelected = this.isSegmentSelected(segment.id, levelIndex);

        for (let i = levelIndex; i < this.levels.length; i++) {
            this.selectedSegments.delete(i);
        }

        this.selectionPath = this.selectionPath.slice(0, levelIndex);

        if (!isCurrentlySelected) {
            this.selectedSegments.set(levelIndex, segment.id);
            this.selectionPath.push(segment);
        }

        this.updateSelectionDisplay();
        this.onSelectionChange?.(this.selectionPath[this.selectionPath.length - 1]?.id ?? null);

        if (this.infoPanelManager && this.dump) {
            const selected = this.selectionPath[this.selectionPath.length - 1];
            this.infoPanelManager.show(selected ?? this.root!, this.dump);
        }

        const hasChildLevels = this.levels.length > levelIndex + 1;
        const willAddNewChild = !isCurrentlySelected && segment.children.length > 0;

        if (willAddNewChild) {
            const childSegments = segment.children;
            if (hasChildLevels) {
                const numLevelsToRemove = this.levels.length - (levelIndex + 1);
                const newChildLevelIndex = levelIndex + 1;
                this._replaceLevels(
                    newChildLevelIndex,
                    segment.kind,
                    segment.id,
                    childSegments,
                    numLevelsToRemove !== 1
                );
            } else {
                this.addLevel(segment.kind, segment.id, childSegments);
            }
        } else if (hasChildLevels) {
            this.removeLevelsFrom(levelIndex + 1);
        }
    }

    /**
     * Replace all levels from `childIndex` down with a single new level,
     * sliding the old ones up and the new one down. `animateHeight` drives the
     * synchronized SVG height animation (only needed when the level count
     * changes).
     */
    private _replaceLevels(
        childIndex: number,
        newLevelName: string,
        newParentSegmentId: string,
        newSegments: SegmentNode[],
        animateHeight: boolean
    ): void {
        const levelsToRemove = this.levels.slice(childIndex);

        // Drop funnel labels up front so they don't overlap during animation.
        levelsToRemove.forEach(level => this.funnels.removeFunnelLabel(level));

        const currentHeight = this.calculateContentHeight();
        this.levels = this.levels.slice(0, childIndex);

        const layout = this.computeLevelLayout(
            newLevelName,
            newParentSegmentId,
            newSegments,
            childIndex
        );
        const newLevel: Level = {
            name: newLevelName,
            parentSegmentId: newParentSegmentId,
            segments: newSegments || [],
            layout: layout,
            svgGroup: this.createLevelGroup(layout, childIndex),
            animationState: 'appearing',
        };

        this.levels.push(newLevel);

        if (animateHeight) {
            const newHeight = this.calculateContentHeight();
            const totalAnimationTime = ANIM_MS + levelsToRemove.length * 50;
            this.animateSvgHeightChange(currentHeight, newHeight, totalAnimationTime);
        }

        levelsToRemove.reverse().forEach((level, i) => {
            setTimeout(() => {
                const parentLevel = this.findParentLevel(level, levelsToRemove);
                this.animateSlideUp(level, parentLevel);
            }, i * 50);
        });

        this.animateSlideDown(newLevel, childIndex);

        requestAnimationFrame(() => this.updateSelectionDisplay());
    }

    private updateSelectionDisplay(): void {
        this.svg.querySelectorAll('.segment').forEach(segment => {
            segment.classList.remove('segment-selected');
        });

        this.selectedSegments.forEach((segmentId, levelIndex) => {
            const rect = this.svg.querySelector(
                `.segment[data-segment-id="${segmentId}"][data-level-index="${levelIndex}"]`
            );
            if (rect) {
                rect.classList.add('segment-selected');
            }
        });
    }

    /**
     * Dim the rects for these node ids (and any rendered later by drill-down).
     * A pruned row group carries its whole subtree, so column chunks and pages
     * under it dim too. Pass an empty set to clear.
     */
    setDimmed(ids: Set<string>): void {
        this.dimmedIds = ids;
        this.svg.querySelectorAll('.segment').forEach(rect => {
            rect.classList.toggle(
                'segment-dimmed',
                this.dimmedIds.has(rect.getAttribute('data-segment-id')!)
            );
        });
    }

    private isSegmentSelected(segmentId: string, levelIndex: number): boolean {
        return this.selectedSegments.get(levelIndex) === segmentId;
    }

    private showSegmentTooltip(event: MouseEvent, segment: SegmentNode): void {
        const label = describe(segment);
        let content =
            label && label !== segment.name
                ? `<strong>${escapeHtml(label)}</strong><br/>`
                : `<strong>${escapeHtml(segment.name)}</strong><br/>`;

        content += `Range: ${formatBytes(segment.start)} - ${formatBytes(segment.end)}<br/>`;
        content += `Size: ${formatBytes(segment.end - segment.start)}`;

        this.showTooltip(event, content);
    }

    private showTooltip(event: MouseEvent, content: string): void {
        this.tooltip.innerHTML = content;
        this.updateTooltipPosition(event);
        this.tooltip.style.visibility = 'visible';
    }

    private updateTooltipPosition(event: MouseEvent): void {
        const config = VisualizationConfig.TOOLTIP;
        const tooltipRect = this.tooltip.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let left = event.pageX + config.OFFSET_X;
        let top = event.pageY + config.OFFSET_Y;

        if (
            event.clientX + config.OFFSET_X + tooltipRect.width >
            viewportWidth - config.BOUNDARY_PADDING
        ) {
            left = event.pageX - tooltipRect.width - config.OFFSET_X;
        }
        if (
            event.clientY + config.OFFSET_Y + tooltipRect.height >
            viewportHeight - config.BOUNDARY_PADDING
        ) {
            top = event.pageY - tooltipRect.height - config.OFFSET_Y;
        }
        if (left < window.scrollX + config.BOUNDARY_PADDING) {
            left = window.scrollX + config.BOUNDARY_PADDING;
        }
        if (top < window.scrollY + config.BOUNDARY_PADDING) {
            top = window.scrollY + config.BOUNDARY_PADDING;
        }

        this.tooltip.style.left = left + 'px';
        this.tooltip.style.top = top + 'px';
    }

    private hideTooltip(): void {
        this.tooltip.style.visibility = 'hidden';
    }

    private handleResize(): void {
        clearTimeout(this.resizeTimeout);
        this.resizeTimeout = setTimeout(() => {
            this.updateSvgSize();
            this.recalculateAllLayouts();
        }, 100);
    }

    private recalculateAllLayouts(): void {
        this.levels.forEach((level, levelIndex) => {
            level.layout = this.computeLevelLayout(
                level.name,
                level.parentSegmentId,
                level.segments,
                levelIndex
            );
            if (level.svgGroup) {
                this.updateLevelGroupLayout(level, levelIndex);
            }
        });

        this.updateSvgHeight();
    }

    private updateLevelGroupLayout(level: Level, levelIndex: number): void {
        this.funnels.removeFunnel(level);

        level.svgGroup.innerHTML = '';
        level.svgGroup.setAttribute('transform', `translate(0, ${level.layout.y})`);

        this.renderSegments(level.svgGroup, level.layout.segments, levelIndex);

        if (level.parentSegmentId && levelIndex > 0 && level.animationState === 'visible') {
            this.funnels.createFunnelConnection(this.levels[levelIndex - 1], level, levelIndex);
        }

        this.updateSelectionDisplay();
    }

    private handleKeyDown(event: KeyboardEvent): void {
        // This listener is on `document`, so Escape/Backspace here would hijack
        // typing (predicate value, bloom probe, URL). Ignore it while an
        // editable element is focused.
        const target = event.target as HTMLElement | null;
        if (
            target &&
            (target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.isContentEditable)
        ) {
            return;
        }
        switch (event.key) {
            case 'Escape':
                this.selectedSegments.clear();
                this.selectionPath = [];
                this.removeLevelsFrom(1);
                this.updateSelectionDisplay();
                this.onSelectionChange?.(null);
                if (this.infoPanelManager && this.dump && this.root) {
                    this.infoPanelManager.show(this.root, this.dump);
                }
                event.preventDefault();
                break;
            case 'Backspace':
                if (this.levels.length > 1) {
                    this.removeLevelsFrom(this.levels.length - 1);
                }
                event.preventDefault();
                break;
        }
    }

    /**
     * Find the level whose layout contains this level's parent segment. Current
     * levels are searched first, then any `extraPools` (e.g. a batch of levels
     * mid-removal) so funnels stay anchored while their parent slides away.
     */
    private findParentLevel(level: Level, extraPools: Level[] = []): Level | null {
        if (!level.parentSegmentId) {
            return null;
        }
        const match = (l: Level): boolean =>
            l.layout?.segments?.some(s => s.segment.id === level.parentSegmentId) ?? false;
        return this.levels.find(match) ?? extraPools.find(match) ?? null;
    }

    /** Clean up resources: unbind listeners and remove the tooltip element. */
    destroy(): void {
        window.removeEventListener('resize', this.onResize);
        document.removeEventListener('keydown', this.onKeyDown);
        clearTimeout(this.resizeTimeout);

        if (this.tooltip && this.tooltip.parentNode) {
            this.tooltip.parentNode.removeChild(this.tooltip);
        }
    }
}
