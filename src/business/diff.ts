/**
 * Structural diff between two dumps (pure, no DOM).
 *
 * Alignment is by structural path: row-group index + column `path_in_schema`
 * (the `column_chunks` key). Compressed size is the primary measure;
 * uncompressed rides along since the footer carries it anyway. Works for full
 * dumps and metadata-only exports alike — everything here comes from the
 * footer metadata both roots share.
 */
import type { AnyDump } from '../types';

/** One aligned column chunk (present in both files at the same rg + path). */
export interface ChunkDiff {
    rowGroup: number;
    column: string;
    compressedA: number;
    compressedB: number;
    /** compressedB - compressedA */
    delta: number;
    uncompressedA: number;
    uncompressedB: number;
    codecA: string;
    codecB: string;
    encodingsA: string[];
    encodingsB: string[];
}

/** Per-row-group compressed totals; rows is null when the file lacks the rg. */
export interface RowGroupDiff {
    rowGroup: number;
    compressedA: number;
    compressedB: number;
    delta: number;
    rowsA: number | null;
    rowsB: number | null;
}

export interface FileDiff {
    chunks: ChunkDiff[];
    /** Chunk paths present only in file B (see chunkPath for the format). */
    added: string[];
    /** Chunk paths present only in file A. */
    removed: string[];
    rowGroups: RowGroupDiff[];
    total: {
        compressedA: number;
        compressedB: number;
        delta: number;
        rowsA: number;
        rowsB: number;
    };
}

/** Human-readable structural path for an added/removed chunk. */
export function chunkPath(rowGroup: number, column: string): string {
    return `rg ${rowGroup} · ${column}`;
}

/** Diff two dumps' footer metadata, aligning by rg index + column path. */
export function diffDumps(a: AnyDump, b: AnyDump): FileDiff {
    const rgsA = a.metadata.row_groups;
    const rgsB = b.metadata.row_groups;

    const chunks: ChunkDiff[] = [];
    const added: string[] = [];
    const removed: string[] = [];
    const rowGroups: RowGroupDiff[] = [];

    for (let i = 0; i < Math.max(rgsA.length, rgsB.length); i++) {
        const colsA = rgsA[i]?.column_chunks ?? {};
        const colsB = rgsB[i]?.column_chunks ?? {};
        let compressedA = 0;
        let compressedB = 0;

        for (const [path, chunkA] of Object.entries(colsA)) {
            const mA = chunkA.metadata;
            compressedA += mA.total_compressed_size;
            const mB = colsB[path]?.metadata;
            if (!mB) {
                removed.push(chunkPath(i, path));
                continue;
            }
            chunks.push({
                rowGroup: i,
                column: path,
                compressedA: mA.total_compressed_size,
                compressedB: mB.total_compressed_size,
                delta: mB.total_compressed_size - mA.total_compressed_size,
                uncompressedA: mA.total_uncompressed_size,
                uncompressedB: mB.total_uncompressed_size,
                codecA: mA.codec,
                codecB: mB.codec,
                encodingsA: [...mA.encodings],
                encodingsB: [...mB.encodings],
            });
        }

        for (const [path, chunkB] of Object.entries(colsB)) {
            compressedB += chunkB.metadata.total_compressed_size;
            if (!(path in colsA)) {
                added.push(chunkPath(i, path));
            }
        }

        rowGroups.push({
            rowGroup: i,
            compressedA,
            compressedB,
            delta: compressedB - compressedA,
            rowsA: rgsA[i]?.row_count ?? null,
            rowsB: rgsB[i]?.row_count ?? null,
        });
    }

    const total = rowGroups.reduce(
        (t, rg) => ({
            compressedA: t.compressedA + rg.compressedA,
            compressedB: t.compressedB + rg.compressedB,
            delta: t.delta + rg.delta,
            rowsA: t.rowsA + (rg.rowsA ?? 0),
            rowsB: t.rowsB + (rg.rowsB ?? 0),
        }),
        { compressedA: 0, compressedB: 0, delta: 0, rowsA: 0, rowsB: 0 }
    );

    return { chunks, added, removed, rowGroups, total };
}
