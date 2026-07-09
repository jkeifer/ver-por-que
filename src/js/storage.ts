/**
 * IndexedDB persistence for the last-loaded dump, so a reload can restore the
 * user's file without re-fetching or re-parsing it.
 *
 * Persistence is best-effort: every failure (blocked storage, a corrupt DB, a
 * quota error) is caught and logged here rather than surfaced, so callers can
 * just await these and not think about it.
 */
import type { AnyDump } from '../types';

const DB_NAME = 'ParquetExplorerDB';

export interface StoredFile {
    id: string;
    data: AnyDump;
    source: string;
    timestamp: number;
}

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);

        request.onerror = () => reject(request.error);

        request.onupgradeneeded = event => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains('files')) {
                db.createObjectStore('files', { keyPath: 'id' });
            }
        };

        request.onsuccess = () => resolve(request.result);
    });
}

async function withStore<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
    const db = await openDB();
    return new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(['files'], mode).objectStore('files'));
        request.onsuccess = () => {
            db.close();
            resolve(request.result);
        };
        request.onerror = () => {
            db.close();
            reject(request.error);
        };
    });
}

async function loadFromIndexedDB(): Promise<StoredFile | null> {
    let db: IDBDatabase;
    try {
        db = await openDB();
    } catch {
        return null;
    }

    // onupgradeneeded only fires on a version bump, so a pre-existing v1 DB
    // that somehow lost the 'files' store won't get it recreated by openDB.
    // Recover by deleting the DB so the next open rebuilds it clean.
    if (!db.objectStoreNames.contains('files')) {
        db.close();
        return new Promise(resolve => {
            const deleteRequest = indexedDB.deleteDatabase(DB_NAME);
            deleteRequest.onsuccess = () => resolve(null);
            deleteRequest.onerror = () => resolve(null);
        });
    }

    return new Promise(resolve => {
        try {
            const getRequest = db
                .transaction(['files'], 'readonly')
                .objectStore('files')
                .get('current-file');
            getRequest.onsuccess = () => {
                db.close();
                resolve((getRequest.result as StoredFile | undefined) ?? null);
            };
            getRequest.onerror = () => {
                db.close();
                resolve(null);
            };
        } catch {
            db.close();
            resolve(null);
        }
    });
}

async function saveToIndexedDB(data: AnyDump, source: string): Promise<void> {
    const fileData: StoredFile = {
        id: 'current-file',
        data: data,
        source: source,
        timestamp: Date.now(),
    };
    await withStore('readwrite', store => store.put(fileData));
}

function clearIndexedDB(): Promise<void> {
    return new Promise(resolve => {
        const deleteRequest = indexedDB.deleteDatabase(DB_NAME);
        deleteRequest.onsuccess = () => resolve();
        deleteRequest.onerror = () => resolve();
        deleteRequest.onblocked = () => resolve();
    });
}

/** Load the last-saved dump, or null if there isn't one / storage failed. */
export async function loadStoredFile(): Promise<StoredFile | null> {
    return loadFromIndexedDB();
}

/** Save the current dump, swallowing (and logging) any storage failure. */
export async function saveStoredFile(data: AnyDump, source: string): Promise<void> {
    try {
        await saveToIndexedDB(data, source);
    } catch (error) {
        console.warn('Failed to save to IndexedDB:', error);
    }
}

/** Clear the stored dump, swallowing (and logging) any storage failure. */
export async function clearStoredFiles(): Promise<void> {
    try {
        await clearIndexedDB();
    } catch (error) {
        console.warn('Failed to clear IndexedDB:', error);
    }
}
