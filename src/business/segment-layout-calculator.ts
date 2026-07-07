/**
 * Segment Layout Calculator
 * Pure functions for calculating segment layouts and positioning.
 */
import { VisualizationConfig, type LayoutConfig } from '../config/visualization-config';
import type { SegmentNode } from './segment-tree';
import { distributeWithMinimums, logarithmicMinimums, type MinSizingOpts } from './min-sizing';

const sizeOf = (n: SegmentNode): number => Math.max(0, n.end - n.start);

/** Byte-layout min-sizing knobs, in container-width pixels, from LAYOUT config. */
const minSizingOpts = (config: LayoutConfig): MinSizingOpts => ({
    baseline: config.STARTING_BASELINE || 5,
    cap: config.MAX_MIN_SEGMENT_WIDTH,
    floor: config.MIN_SEGMENT_WIDTH,
    logFactor: config.LOG_SCALE_FACTOR,
});

export interface SegmentLayout {
    segment: SegmentNode;
    x: number;
    y: number;
    width: number;
    height: number;
    widthPercent: number;
    isExpanded: boolean;
    naturalWidth: number;
    minWidth: number;
}

export interface LevelLayout {
    x: number;
    y: number;
    width: number;
    height: number;
    segments: SegmentLayout[];
    totalSize?: number;
    minStart?: number;
    maxEnd?: number;
    levelName: string;
    parentSegmentId: string | null;
    segmentCount?: number;
}

interface SegmentWidthData {
    segment: SegmentNode;
    naturalWidthPercent: number;
    naturalWidthPixels: number;
    finalWidthPercent: number;
    finalWidthPixels: number;
    isExpanded: boolean;
    minWidth: number;
}

export class SegmentLayoutCalculator {
    /** Calculate proportional widths for segments. */
    static calculateSegmentWidths(
        segments: SegmentNode[],
        containerWidth: number,
        config: LayoutConfig = VisualizationConfig.LAYOUT
    ): SegmentLayout[] {
        if (!segments || segments.length === 0) {
            return [];
        }

        const minStart = Math.min(...segments.map(s => s.start));
        const maxEnd = Math.max(...segments.map(s => s.end));
        const span = maxEnd - minStart;

        const distributed = distributeWithMinimums(
            segments.map(sizeOf),
            span,
            containerWidth,
            minSizingOpts(config)
        );

        const segmentData: SegmentWidthData[] = segments.map((segment, index) => {
            const d = distributed[index]!;
            return {
                segment: segment,
                naturalWidthPercent: (d.natural / containerWidth) * 100,
                naturalWidthPixels: d.natural,
                finalWidthPercent: (d.extent / containerWidth) * 100,
                finalWidthPixels: d.extent,
                isExpanded: d.isExpanded,
                minWidth: d.min,
            };
        });

        return this.calculateSegmentPositions(segmentData, config);
    }

    /** Calculate logarithmic minimum widths for segments (delegates to min-sizing). */
    static calculateLogarithmicMinWidths(
        segments: SegmentNode[],
        _totalSize: number,
        containerWidth: number,
        config: LayoutConfig
    ): number[] {
        return logarithmicMinimums(segments.map(sizeOf), containerWidth, minSizingOpts(config));
    }

    /** Calculate segment positions based on calculated widths. */
    static calculateSegmentPositions(
        segmentData: SegmentWidthData[],
        config: LayoutConfig
    ): SegmentLayout[] {
        let currentLeft = 0;

        return segmentData.map(data => {
            const layout: SegmentLayout = {
                segment: data.segment,
                x: currentLeft,
                y: config.SEGMENT_MARGIN,
                width: data.finalWidthPixels,
                height: config.LEVEL_HEIGHT - 2 * config.SEGMENT_MARGIN,
                widthPercent: data.finalWidthPercent,
                isExpanded: data.isExpanded,
                naturalWidth: data.naturalWidthPixels,
                minWidth: data.minWidth,
            };

            currentLeft += data.finalWidthPixels;
            return layout;
        });
    }

    /** Calculate layout for a complete level. */
    static computeLevelLayout(
        levelName: string,
        parentSegmentId: string | null,
        segments: SegmentNode[],
        levelIndex: number,
        containerWidth: number,
        config: LayoutConfig
    ): LevelLayout {
        const y = levelIndex * (config.LEVEL_HEIGHT + config.LEVEL_SPACING);

        if (!segments || segments.length === 0) {
            return {
                x: 0,
                y,
                width: containerWidth,
                height: config.LEVEL_HEIGHT,
                segments: [],
                levelName: levelName,
                parentSegmentId: parentSegmentId,
            };
        }

        const segmentLayouts = this.calculateSegmentWidths(segments, containerWidth, config);

        const minStart = Math.min(...segments.map(s => s.start));
        const maxEnd = Math.max(...segments.map(s => s.end));
        const totalSize = maxEnd - minStart;

        return {
            x: 0,
            y: y,
            width: containerWidth,
            height: config.LEVEL_HEIGHT,
            segments: segmentLayouts,
            totalSize: totalSize,
            minStart: minStart,
            maxEnd: maxEnd,
            levelName: levelName,
            parentSegmentId: parentSegmentId,
            segmentCount: segments.length,
        };
    }
}
