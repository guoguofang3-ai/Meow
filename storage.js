// storage.js — IndexedDB 封装，替代 localStorage
// 用法：await MeowStorage.get('key') / await MeowStorage.set('key', value)

const MeowStorage = (() => {
  const DB_NAME = 'MeowDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'kv';
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  function getStore(mode = 'readonly') {
    return openDB().then(db =>
      db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)
    );
  }

  function promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  return {
    async get(key) {
      const store = await getStore('readonly');
      const val = await promisify(store.get(key));
      return val === undefined ? null : val;
    },
    async set(key, value) {
      const store = await getStore('readwrite');
      await promisify(store.put(value, key));
    },
    async remove(key) {
      const store = await getStore('readwrite');
      await promisify(store.delete(key));
    },
    async keys() {
      const store = await getStore('readonly');
      return promisify(store.getAllKeys());
    },
    async clear() {
      const store = await getStore('readwrite');
      await promisify(store.clear());
    },
    async getMany(keys) {
      const store = await getStore('readonly');
      const results = {};
      await Promise.all(
        keys.map(async (key) => {
          const val = await promisify(store.get(key));
          results[key] = val === undefined ? null : val;
        })
      );
      return results;
    },
    async setMany(entries) {
      const store = await getStore('readwrite');
      await Promise.all(
        Object.entries(entries).map(([key, value]) =>
          promisify(store.put(value, key))
        )
      );
    },
    // 导出全部数据（备份用）
    async exportAll() {
      const store = await getStore('readonly');
      const keys = await promisify(store.getAllKeys());
      const data = {};
      await Promise.all(
        keys.map(async (key) => {
          data[key] = await promisify(store.get(key));
        })
      );
      return data;
    },
    // 导入数据（恢复备份用）
    async importAll(data) {
      const store = await getStore('readwrite');
      await promisify(store.clear());
      await Promise.all(
        Object.entries(data).map(([key, value]) =>
          promisify(store.put(value, key))
        )
      );
    }
  };
})();

// ===== 迁移脚本：从 localStorage 搬到 IndexedDB，跑一次自动跳过 =====
async function migrateFromLocalStorage() {
  const migrated = await MeowStorage.get('__migrated__');
  if (migrated) return;

  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    try {
      data[key] = JSON.parse(localStorage.getItem(key));
    } catch {
      data[key] = localStorage.getItem(key);
    }
  }

  if (Object.keys(data).length > 0) {
    await MeowStorage.setMany(data);
    console.log(`迁移完成，共 ${Object.keys(data).length} 条数据`);
  }

  await MeowStorage.set('__migrated__', Date.now());
}
