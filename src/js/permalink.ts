/**
 * Permalink hash (de)serialization.
 *
 * The location HASH carries app state as URLSearchParams-encoded pairs
 * ("#node=rg_0&lens=..."), keeping it independent of the query string, which
 * is owned by `?url=` ingest. Today only `node` is used; later phases append
 * more keys, so parse/serialize goes through URLSearchParams from day one.
 */

/** Read one param from a location hash ("", "#", or "#k=v&k2=v2"). */
export function getHashParam(hash: string, key: string): string | null {
    return new URLSearchParams(hash.replace(/^#/, '')).get(key);
}

/**
 * Return a new hash string with `key` set (or removed when null), preserving
 * any other params. Returns '' when nothing remains.
 */
export function setHashParam(hash: string, key: string, value: string | null): string {
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    if (value === null) {
        params.delete(key);
    } else {
        params.set(key, value);
    }
    const out = params.toString();
    return out ? `#${out}` : '';
}
