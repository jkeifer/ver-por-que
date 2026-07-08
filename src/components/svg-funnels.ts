/**
 * SVG funnel layer for the byte visualizer.
 * Builds, animates, and tears down the trapezoid "funnel" shapes and their
 * labels that connect a parent segment to its drilled-down child level.
 */
import { VisualizationConfig, type LayoutConfig } from '../config/visualization-config';
import type { SegmentLayout } from '../business/segment-layout-calculator';
import type { FunnelElement, Level, SegmentRect } from './svg-byte-visualizer';

type SvgElementFactory = (tag: string, attributes?: Record<string, string | number>) => SVGElement;

export class FunnelLayer {
    constructor(
        private svg: SVGSVGElement,
        private config: LayoutConfig,
        private createSvgElement: SvgElementFactory,
        private getWidth: () => number
    ) {}

    /** Build the trapezoid points string shared by all funnel shapes. */
    private funnelPoints(
        parentLeft: number,
        parentRight: number,
        parentY: number,
        childRight: number,
        childY: number
    ): string {
        return [
            `${parentLeft},${parentY}`,
            `${parentRight},${parentY}`,
            `${childRight},${childY}`,
            `0,${childY}`,
        ].join(' ');
    }

    /** Create + insert a funnel polygon behind the level groups. */
    private createFunnel(
        points: string,
        parentSegmentId: string | null,
        childLevelIndex: number,
        animated: boolean
    ): FunnelElement {
        const funnel = this.createSvgElement('polygon', {
            points: points,
            fill: VisualizationConfig.getCSSVariable('--funnel-fill'),
            class: animated ? 'funnel-connection animated-funnel' : 'funnel-connection',
            'data-parent-segment': parentSegmentId ?? '',
            'data-child-level': childLevelIndex,
            style: animated
                ? 'pointer-events: none; transition: points 300ms cubic-bezier(0.4, 0, 0.2, 1);'
                : 'pointer-events: none;',
        }) as FunnelElement;

        const firstLevel = this.svg.querySelector('.level');
        if (firstLevel) {
            this.svg.insertBefore(funnel, firstLevel);
        } else {
            this.svg.appendChild(funnel);
        }
        return funnel;
    }

    /**
     * Shared setup for both funnel entry points: locate the parent segment,
     * compute geometry, and create the polygon + label at `childY`. Returns the
     * funnel plus the parent bounds (for callers that animate the shape), or
     * null when the parent segment isn't laid out.
     */
    private buildFunnel(
        parentLevel: Level,
        childLevel: Level,
        childLevelIndex: number,
        childY: number,
        animated: boolean
    ): { funnel: FunnelElement; parentLeft: number; parentRight: number; parentY: number } | null {
        const parentSegmentLayout = parentLevel.layout.segments.find(
            s => s.segment.id === childLevel.parentSegmentId
        );
        if (!parentSegmentLayout) {
            return null;
        }

        const parentY =
            parentLevel.layout.y + parentLevel.layout.height - this.config.SEGMENT_MARGIN;
        const parentLeft = parentSegmentLayout.x;
        const parentRight = parentSegmentLayout.x + parentSegmentLayout.width;

        const funnel = this.createFunnel(
            this.funnelPoints(parentLeft, parentRight, parentY, this.getWidth(), childY),
            childLevel.parentSegmentId,
            childLevelIndex,
            animated
        );

        childLevel.funnelElement = funnel;
        this.createFunnelLabel(
            parentSegmentLayout,
            parentLeft,
            parentRight,
            parentY,
            parentY,
            funnel
        );

        return { funnel, parentLeft, parentRight, parentY };
    }

    /** Static funnel used when recalculating layouts (no entry animation). */
    createFunnelConnection(
        parentLevel: Level | undefined,
        childLevel: Level,
        childLevelIndex: number
    ): void {
        if (!parentLevel) {
            return;
        }
        this.buildFunnel(
            parentLevel,
            childLevel,
            childLevelIndex,
            childLevel.layout.y + this.config.SEGMENT_MARGIN,
            false
        );
    }

    /** Funnel whose lower edge animates down as the child level slides in. */
    createAnimatedFunnel(
        childLevel: Level,
        childLevelIndex: number,
        parentLevel: Level,
        startY: number,
        finalY: number
    ): void {
        const built = this.buildFunnel(
            parentLevel,
            childLevel,
            childLevelIndex,
            startY + this.config.SEGMENT_MARGIN,
            true
        );
        if (!built) {
            return;
        }

        const { funnel, parentLeft, parentRight, parentY } = built;
        const finalChildY = finalY + this.config.SEGMENT_MARGIN;

        requestAnimationFrame(() => {
            funnel.setAttribute(
                'points',
                this.funnelPoints(parentLeft, parentRight, parentY, this.getWidth(), finalChildY)
            );
        });
    }

    private createFunnelLabel(
        parentSegmentLayout: SegmentLayout,
        parentLeft: number,
        parentRight: number,
        initialParentY: number,
        finalParentY: number,
        funnelElement: FunnelElement
    ): void {
        const segment = parentSegmentLayout.segment;

        const segmentRect = this.svg.querySelector(
            `.segment[data-segment-id="${segment.id}"]`
        ) as SegmentRect | null;

        if (segmentRect && segmentRect.labelElement) {
            return;
        }

        const segmentWidth = parentRight - parentLeft;
        const labelX = parentLeft + segmentWidth / 2;
        const funnelMidY =
            initialParentY + ((finalParentY || initialParentY) - initialParentY) / 2 + 15;
        const labelY = funnelMidY;

        const label = this.createSvgElement('text', {
            x: labelX,
            y: labelY,
            'text-anchor': 'middle',
            'dominant-baseline': 'central',
            fill: 'var(--text-primary)',
            'font-family': 'var(--font-sans)',
            'font-size': '11px',
            'font-weight': '500',
            class: 'funnel-label',
            'pointer-events': 'none',
            style: 'user-select: none; transition: opacity 300ms ease;',
        });

        label.textContent = segment.name;

        const firstLevel = this.svg.querySelector('.level');
        if (firstLevel) {
            this.svg.insertBefore(label, firstLevel);
        } else {
            this.svg.appendChild(label);
        }

        funnelElement.labelElement = label;

        requestAnimationFrame(() => {
            const textBBox = (label as SVGGraphicsElement).getBBox();
            const svgWidth = this.getWidth();

            const parentTop = initialParentY;
            const childTop = initialParentY + 30;
            const labelProgress = Math.min(
                1,
                Math.max(0, (labelY - parentTop) / Math.max(1, childTop - parentTop))
            );

            const funnelLeftAtLabel = parentLeft - parentLeft * labelProgress;
            const funnelRightAtLabel =
                parentLeft + segmentWidth + (svgWidth - parentLeft - segmentWidth) * labelProgress;

            const labelLeft = labelX - textBBox.width / 2;
            const labelRight = labelX + textBBox.width / 2;

            let adjustedX = labelX;
            let anchor = 'middle';
            const margin = 5;

            if (labelRight > funnelRightAtLabel - margin) {
                adjustedX = funnelRightAtLabel - margin;
                anchor = 'end';
            } else if (labelLeft < funnelLeftAtLabel + margin) {
                adjustedX = funnelLeftAtLabel + margin;
                anchor = 'start';
            }

            if (adjustedX !== labelX || anchor !== 'middle') {
                label.setAttribute('x', String(adjustedX));
                label.setAttribute('text-anchor', anchor);
            }

            const funnelWidth = funnelRightAtLabel - funnelLeftAtLabel;
            const maxLabelWidth = funnelWidth - 2 * margin;
            if (textBBox.width > maxLabelWidth) {
                let text = segment.name;
                label.textContent = text;

                while (
                    text.length > 5 &&
                    (label as SVGGraphicsElement).getBBox().width > maxLabelWidth
                ) {
                    text = text.slice(0, -1);
                    label.textContent = text + '…';
                }
            }
        });
    }

    /** Remove a level's funnel element and its label from the DOM. */
    removeFunnel(level: Level): void {
        const funnel = level.funnelElement;
        if (funnel && funnel.parentNode) {
            if (funnel.labelElement && funnel.labelElement.parentNode) {
                funnel.labelElement.parentNode.removeChild(funnel.labelElement);
            }
            funnel.parentNode.removeChild(funnel);
        }
    }

    /** Remove only a level's funnel label (keeps the funnel). */
    removeFunnelLabel(level: Level): void {
        const funnel = level.funnelElement;
        if (funnel && funnel.labelElement) {
            if (funnel.labelElement.parentNode) {
                funnel.labelElement.parentNode.removeChild(funnel.labelElement);
            }
            funnel.labelElement = null;
        }
    }

    animateFunnelSlideUp(childLevel: Level, parentLevel: Level, targetY: number): void {
        const funnel = childLevel.funnelElement;
        if (!funnel) {
            return;
        }

        const parentSegmentLayout = parentLevel.layout.segments.find(
            s => s.segment.id === childLevel.parentSegmentId
        );
        if (!parentSegmentLayout) {
            return;
        }

        const targetParentY =
            parentLevel.layout.y + parentLevel.layout.height - this.config.SEGMENT_MARGIN;
        const targetChildY = targetY + this.config.SEGMENT_MARGIN;
        const parentLeft = parentSegmentLayout.x;
        const parentRight = parentSegmentLayout.x + parentSegmentLayout.width;

        requestAnimationFrame(() => {
            funnel.setAttribute(
                'points',
                this.funnelPoints(
                    parentLeft,
                    parentRight,
                    targetParentY,
                    this.getWidth(),
                    targetChildY
                )
            );
        });
    }
}
