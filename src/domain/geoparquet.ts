/**
 * GeoParquet + geometry column semantics.
 *
 * GeoParquet (used by Overture and most geo tooling) predates the native
 * Parquet GEOMETRY logical type: the geometry column is a plain BYTE_ARRAY and
 * its WKB encoding + spatial extent are declared in the file's `geo` key-value
 * metadata instead. This module reads that metadata and answers the two
 * geometry-awareness questions the views need — "is this a WKB column?" and
 * "what should its display type say?" — layered on the pure `displayType`.
 */
import { displayType } from './parquet-type-resolver';
import type { AnyDump, SchemaLeaf } from '../types';

/** One column's entry in the GeoParquet `geo` metadata. */
export interface GeoColumn {
    encoding?: string;
    /** [xmin, ymin, xmax, ymax] or [xmin, ymin, zmin, xmax, ymax, zmax]. */
    bbox?: number[];
    geometry_types?: string[];
}

// The `geo` metadata JSON can be large (Overture files list every column with
// its full bbox); parse it once per dump and cache, since the info panel asks
// for it on every panel open across several column views.
const cache = new WeakMap<AnyDump, Record<string, GeoColumn>>();

/**
 * The per-column `geo` entries, keyed by column name (empty when the file isn't
 * GeoParquet). Memoized per dump — the source metadata never changes.
 */
export function geoparquetColumns(dump: AnyDump): Record<string, GeoColumn> {
    const hit = cache.get(dump);
    if (hit) {
        return hit;
    }
    const columns = parseGeoColumns(dump);
    cache.set(dump, columns);
    return columns;
}

function parseGeoColumns(dump: AnyDump): Record<string, GeoColumn> {
    const entry = dump.metadata.key_value_metadata?.find(e => e.key === 'geo');
    if (!entry?.value) {
        return {};
    }
    try {
        return (JSON.parse(entry.value) as { columns?: Record<string, GeoColumn> }).columns ?? {};
    } catch {
        return {};
    }
}

/** WKB geometry column: a native GEOMETRY/GEOGRAPHY leaf, or a GeoParquet column. */
export function isWkbColumn(
    leaf: SchemaLeaf | null | undefined,
    geo: GeoColumn | undefined
): boolean {
    const lt = leaf?.logical_type?.logical_type;
    return lt === 'GEOMETRY' || lt === 'GEOGRAPHY' || geo?.encoding === 'WKB';
}

/**
 * Display type for a column, GeoParquet-aware. A GeoParquet geometry column has
 * no logical type, so the pure leaf displayType falls back to BYTE_ARRAY; name
 * it from the `geo` metadata instead. Used consistently by every column view.
 */
export function columnDisplayType(
    leaf: SchemaLeaf | null | undefined,
    geo: GeoColumn | undefined,
    physicalFallback: string
): string {
    if (geo?.encoding === 'WKB') {
        return 'WKB geometry (GeoParquet)';
    }
    return leaf ? displayType(leaf) : physicalFallback;
}
