// IndexedDB 缓存：体积数据（TypedArray 的 ArrayBuffer）
const VolumeCache = (() => {
  const DB_NAME = 'vr-cache';
  const STORE = 'volumes';
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function get(key) {
    try {
      const db = await open();
      return await new Promise((resolve) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (_) { return null; }
  }

  async function put(key, value) {
    try {
      const db = await open();
      await new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
    } catch (_) { /* 缓存失败不影响功能 */ }
  }

  return { get, put };
})();
