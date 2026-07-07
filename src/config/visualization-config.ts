/**
 * Visualization Configuration
 * Centralized layout, color, and behavior constants plus segment color logic.
 */
import type { Kind } from '../business/segment-tree';

export interface LayoutConfig {
    LEVEL_HEIGHT: number;
    LEVEL_SPACING: number;
    TOP_MARGIN: number;
    SEGMENT_MARGIN: number;
    CORNER_RADIUS: number;
    MIN_SEGMENT_WIDTH: number;
    MAX_MIN_SEGMENT_WIDTH: number;
    LOG_SCALE_FACTOR: number;
    STARTING_BASELINE: number;
    DEFAULT_HEIGHT: number;
    MIN_WIDTH: number;
    MAX_WIDTH: number;
    CONNECTION_OPACITY: number;
    HIT_TEST_TOLERANCE: number;
}

interface RGB {
    r: number;
    g: number;
    b: number;
}

export class VisualizationConfig {
    /** Layout constants for the SVG visualizer. */
    static LAYOUT: LayoutConfig = {
        LEVEL_HEIGHT: 40,
        LEVEL_SPACING: 32,
        TOP_MARGIN: 20,
        SEGMENT_MARGIN: 2,
        CORNER_RADIUS: 0,
        MIN_SEGMENT_WIDTH: 3,
        MAX_MIN_SEGMENT_WIDTH: 25,
        LOG_SCALE_FACTOR: 2,
        STARTING_BASELINE: 5,
        DEFAULT_HEIGHT: 400,
        MIN_WIDTH: 300,
        MAX_WIDTH: 1200,
        CONNECTION_OPACITY: 0.3,
        HIT_TEST_TOLERANCE: 2,
    };

    /** Color scheme (only the default fallback is used directly). */
    static COLORS = {
        DEFAULT: '--text-secondary',
    };

    /** Tooltip positioning configuration. */
    static TOOLTIP = {
        OFFSET_X: 10,
        OFFSET_Y: -10,
        BOUNDARY_PADDING: 10,
        MIN_WIDTH: 200,
    };

    /**
     * Color family (CSS custom properties) per segment kind. Kinds that repeat
     * as siblings (row groups, column chunks, pages, schema groups/leaves, kv
     * entries) get a light/medium/dark family so consecutive segments alternate
     * shade and their boundaries stay visible without delimiter lines. Singleton
     * or already-distinct kinds get a one-entry family.
     */
    static KIND_COLORS: Record<Kind, string[]> = {
        file: ['--generic-segment-color'],
        magic_header: ['--magic-color'],
        magic_footer: ['--magic-color'],
        footer: ['--footer-color'],
        data_region: ['--row-groups'],
        metadata_region: ['--metadata-container-color'],
        row_group: ['--row-group-light', '--row-group-medium', '--row-group-dark'],
        column_chunk: ['--column-chunk-light', '--column-chunk-medium', '--column-chunk-dark'],
        dictionary_page: ['--dictionary-page-color'],
        data_page: ['--data-page-light', '--data-page-medium', '--data-page-dark'],
        index_page: ['--index-page-light', '--index-page-medium', '--index-page-dark'],
        column_index: ['--column-index-medium'],
        offset_index: ['--column-index-dark'],
        bloom_filter: ['--column-index-light'],
        schema_root: ['--schema-group-dark'],
        schema_group: ['--schema-group-light', '--schema-group-medium', '--schema-group-dark'],
        schema_leaf: ['--schema-element-light', '--schema-element-medium', '--schema-element-dark'],
        row_groups_meta: ['--row-groups'],
        row_group_meta: ['--row-group-light', '--row-group-medium', '--row-group-dark'],
        chunk_meta: ['--column-chunk-light', '--column-chunk-medium', '--column-chunk-dark'],
        kv_meta: ['--red-medium'],
        kv_entry: ['--green-light', '--green-medium', '--green-dark'],
    };

    /**
     * CSS custom property name for a segment kind. `index` is the segment's
     * position within its level; it selects a shade within the kind's family so
     * adjacent same-kind segments differ.
     */
    static getSegmentColor(kind: Kind, index = 0): string {
        const family = VisualizationConfig.KIND_COLORS[kind];
        if (!family || family.length === 0) {
            return VisualizationConfig.COLORS.DEFAULT;
        }
        return family[index % family.length]!;
    }

    /**
     * Get contrast class name based on background color luminance.
     */
    static getContrastClass(backgroundColor: string): string {
        let actualColor = backgroundColor;
        if (backgroundColor.startsWith('--')) {
            const computedColor = getComputedStyle(document.documentElement).getPropertyValue(
                backgroundColor
            );
            actualColor = computedColor.trim();
        }

        const rgb = this._parseColor(actualColor);
        if (!rgb) {
            return 'segment-on-light';
        }

        const luminance = this._calculateLuminance(rgb.r, rgb.g, rgb.b);
        return luminance < 0.4 ? 'segment-on-dark' : 'segment-on-light';
    }

    private static _parseColor(colorStr: string): RGB | null {
        if (colorStr.startsWith('#')) {
            const hex = colorStr.slice(1);
            if (hex.length === 3) {
                return {
                    r: parseInt(hex[0]! + hex[0]!, 16),
                    g: parseInt(hex[1]! + hex[1]!, 16),
                    b: parseInt(hex[2]! + hex[2]!, 16),
                };
            } else if (hex.length === 6) {
                return {
                    r: parseInt(hex.slice(0, 2), 16),
                    g: parseInt(hex.slice(2, 4), 16),
                    b: parseInt(hex.slice(4, 6), 16),
                };
            }
        }

        const rgbMatch = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (rgbMatch) {
            return {
                r: parseInt(rgbMatch[1]!),
                g: parseInt(rgbMatch[2]!),
                b: parseInt(rgbMatch[3]!),
            };
        }

        return null;
    }

    private static _calculateLuminance(r: number, g: number, b: number): number {
        const rs = r / 255;
        const gs = g / 255;
        const bs = b / 255;

        const rLin = rs <= 0.03928 ? rs / 12.92 : Math.pow((rs + 0.055) / 1.055, 2.4);
        const gLin = gs <= 0.03928 ? gs / 12.92 : Math.pow((gs + 0.055) / 1.055, 2.4);
        const bLin = bs <= 0.03928 ? bs / 12.92 : Math.pow((bs + 0.055) / 1.055, 2.4);

        return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
    }
}
