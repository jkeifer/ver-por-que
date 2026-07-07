/**
 * The renderer contract a lens must satisfy.
 *
 * A lens is a RENDERER over the same SegmentNode tree — no new projection, no
 * new offsets. This is exactly the surface main.ts drives; anything beyond it
 * is a lens implementation detail.
 */
import type { AnyDump } from '../types';
import type { SegmentNode } from '../business/segment-tree';

export interface Visualizer {
    /** Fired with the deepest selected node's id (null when nothing is selected). */
    onSelectionChange: ((id: string | null) => void) | null;

    /**
     * Initialize with parquet data and the already-projected segment tree.
     * The tree is projected once by main and shared across lenses — a lens
     * renders it, it does not re-project.
     */
    initWithData(data: AnyDump, tree: SegmentNode): void;

    /**
     * Programmatically select a node by id. Returns false (a silent no-op)
     * when the id isn't in the tree — or is the root.
     */
    selectNodeById(id: string): boolean;

    /**
     * Dim the rects for these node ids (query-pruned segments). Pass an empty
     * set to clear.
     */
    setDimmed(ids: Set<string>): void;

    /** Clean up resources: unbind listeners, remove floating elements. */
    destroy(): void;
}
