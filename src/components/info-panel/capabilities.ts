/**
 * The worker-backed capabilities the info panel's interactive cards call. Only
 * raw-parquet loads have them (the worker holds the file); a JSON dump or
 * metadata-only export passes null and the cards degrade. Kept in their own
 * module so both the manager and the bloom-probe widget can reference them
 * without importing each other.
 */
import type {
    BloomDensityResult,
    BloomProbeResult,
    DictionaryPreviewResult,
    PreviewResult,
} from '../../js/worker/pyodide-parquet';

/**
 * Tests a value against a column chunk's bloom filter. Only raw-parquet loads
 * have one (the worker holds the file); the value crosses as a string.
 */
export type BloomProbe = (
    rowGroup: number,
    column: string,
    value: string
) => Promise<BloomProbeResult>;

/**
 * Reads a column chunk's whole bloom filter and reduces it to a density strip.
 * Only raw-parquet loads have one, same lifecycle as BloomProbe.
 */
export type BloomDensity = (rowGroup: number, column: string) => Promise<BloomDensityResult>;

/**
 * Reads a contiguous run of `count` 256-bit blocks' raw bytes (base64) from a
 * column chunk's bloom filter, so a window of block bit-grids renders on demand
 * at any filter size in one call. Same lifecycle as BloomDensity.
 */
export type BloomBlocks = (
    rowGroup: number,
    column: string,
    start: number,
    count: number
) => Promise<string>;

/**
 * Decodes a window of a data page in the worker's current file, starting at
 * value `offset`; with `skipNulls` the window is up to `limit` non-null values.
 * Only raw-parquet loads have one, same as BloomProbe.
 */
export type ValuePreview = (
    rowGroup: number,
    column: string,
    pageIndex: number,
    offset: number,
    limit: number,
    skipNulls: boolean
) => Promise<PreviewResult>;

/**
 * Decodes a window of a column chunk's dictionary page (its distinct values) in
 * the worker's current file, from entry `offset`. Only raw-parquet loads have
 * one, same lifecycle as ValuePreview.
 */
export type DictionaryPreview = (
    rowGroup: number,
    column: string,
    offset: number,
    limit: number
) => Promise<DictionaryPreviewResult>;

/**
 * The five worker-backed capabilities as one bundle. They share a lifecycle —
 * present together (a raw-parquet load, or a full dump with a fetchable source)
 * or absent together (metadata-only / source-less) — so they wire, reset, and
 * degrade as a unit rather than five parallel slots.
 */
export interface WorkerCapabilities {
    bloomProbe: BloomProbe;
    bloomDensity: BloomDensity;
    bloomBlocks: BloomBlocks;
    valuePreview: ValuePreview;
    dictionaryPreview: DictionaryPreview;
}
