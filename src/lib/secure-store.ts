/**
 * Kleiner Schlüssel-Wert-Speicher in der IndexedDB der Extension-Origin.
 *
 * Für Geheimnisse wie Tokens statt `storage.local`, weil Content-Scripts `storage.local` lesen können.
 * Die IndexedDB der Extension ist nur von Extension-Seiten und dem Background aus erreichbar;
 * Content-Scripts laufen in der Origin der Mediathek-Seite. Nur im Background verwenden.
 */
const DB_NAME = 'synchrothek';
const STORE = 'secure';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = op(tx.objectStore(STORE));
    // Erst nach Abschluss der Transaktion melden, damit Schreibvorgänge sicher gespeichert sind
    tx.oncomplete = () => resolve(req.result as T);
    tx.onerror = tx.onabort = () => reject(tx.error ?? req.error);
  });
}

export function readSecure<T>(key: string): Promise<T | undefined> {
  return run<T | undefined>('readonly', (s) => s.get(key));
}

export async function writeSecure(key: string, value: unknown): Promise<void> {
  await run('readwrite', (s) => s.put(value, key));
}

export async function deleteSecure(key: string): Promise<void> {
  await run('readwrite', (s) => s.delete(key));
}
