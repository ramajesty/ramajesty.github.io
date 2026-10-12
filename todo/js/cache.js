// オフライン閲覧用に、最後に読み込んだデータを端末(IndexedDB)に保存する
const DB_NAME = 'outline-todo';
let dbPromise = null;

function open() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  }));
}

export const cacheGet = (key) => run('readonly', (s) => s.get(key)).catch(() => undefined);
export const cacheSet = (key, value) => run('readwrite', (s) => s.put(value, key)).catch(() => {});
export const cacheClear = () => run('readwrite', (s) => s.clear()).catch(() => {});
