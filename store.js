/**
 * 车间质检本 · 本机存储层
 *
 * 设计要求只有两条，但都很硬：
 *   1. 记录一旦落盘，刷新页面、关掉浏览器、重启电脑都还在；
 *   2. 环境不给力时（浏览器禁了 IndexedDB、本机空间不够）不许静静地把数据丢掉，
 *      必须换一层能用的存法，并且明确告诉使用者「现在存在哪、风险是什么」。
 *
 * 所以这里把「驱动」和「仓库」分开：
 *   - 驱动（driver）：真正落盘的地方，有 indexeddb / localstorage / memory 三种；
 *   - 仓库（store）：对上层提供统一的 list / put / remove / usage / export / purge。
 * 上层代码只认仓库，不认识驱动，将来加 SQLite、File System Access 都不用改界面。
 *
 * 本文件不引用任何浏览器全局变量（都在函数里判断），因此能在 Node 下跑测试。
 */

/* ==========================================================================
   1. 错误与容量口径
   ========================================================================== */

/** 空间不够时抛这个，带上「怎么救」的操作清单 */
export class QuotaError extends Error {
  constructor(message, advice, cause) {
    super(message);
    this.name = 'QuotaError';
    this.advice = advice || null;
    if (cause) this.cause = cause;
  }
}

/** 保守估算一个值占多少字节：字符串按 UTF-16 算 2 字节，Blob 用它的 size */
export function estimateBytes(value, seen = new Set()) {
  if (value === null || value === undefined) return 0;
  const t = typeof value;
  if (t === 'boolean') return 4;
  if (t === 'number') return 8;
  if (t === 'string') return value.length * 2;
  if (t === 'bigint') return 16;
  if (t === 'function' || t === 'symbol') return 0;
  if (t === 'object') {
    if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size || 0;
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(value)) {
      return value.byteLength || 0;
    }
    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return value.byteLength || 0;
    if (seen.has(value)) return 0;
    seen.add(value);
    if (Array.isArray(value)) return value.reduce((s, v) => s + estimateBytes(v, seen), 40);
    if (value instanceof Date) return 16;
    let sum = 40;
    for (const [k, v] of Object.entries(value)) sum += k.length * 2 + estimateBytes(v, seen);
    return sum;
  }
  return 0;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 拆成「干净」的普通对象再落盘。
 *
 * 为什么必须做：界面层（Vue）里拿到的对象/数组是响应式代理（Proxy），
 * IndexedDB 的结构化克隆**不接受代理**，会抛 DataCloneError
 * （实测报错：`[object Array] could not be cloned`）。
 * 存储层是最后一关，不能指望每个调用方都记得 toRaw()，所以统一在这里拆。
 * Blob / ArrayBuffer / Date 原样保留（照片是按 Blob 存的）。
 */
export function toPlain(value, seen = new WeakMap()) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return value;
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(value)) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const v of value) out.push(toPlain(v, seen));
    return out;
  }

  const out = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value)) out[k] = toPlain(v, seen);
  return out;
}

/** 容量阈值：75% 提醒、90% 报警（车间平板常年不清理，必须提前喊） */
export const QUOTA_LEVELS = { warn: 0.75, critical: 0.9 };

/**
 * 容量建议：界面上的提示条直接照着渲染。
 * @returns {{ level: 'unknown'|'ok'|'warn'|'critical', pct: number|null,
 *            title: string, message: string, actions: Array }}
 */
export function quotaAdvice({ usedBytes = 0, quotaBytes = 0, count = 0 } = {}) {
  const purgeAction = {
    id: 'purge',
    label: '导出并清理旧批次',
    detail: '先导出 CSV 存档，再删掉 30 天前的批次（照片最占地方）。',
  };
  const exportAction = {
    id: 'export',
    label: '导出全部数据',
    detail: '导出成 JSON + CSV 放到 U 盘，换机器或清理前都先做这一步。',
  };
  const photoAction = {
    id: 'photos',
    label: '按记录删照片',
    detail: '在追溯页打开一条记录，可只删照片、保留数据。',
  };

  if (!quotaBytes || !Number.isFinite(quotaBytes) || quotaBytes <= 0) {
    return {
      level: 'unknown',
      pct: null,
      title: '用了多少空间：这台机器不告诉我',
      message: `当前浏览器不提供容量信息。已保存 ${count} 条记录，约 ${formatBytes(usedBytes)}。建议每周导出一次备份。`,
      actions: [exportAction],
    };
  }

  const pct = usedBytes / quotaBytes;
  if (pct >= QUOTA_LEVELS.critical) {
    return {
      level: 'critical',
      pct,
      title: `本机空间快满了（已用 ${(pct * 100).toFixed(0)}%）`,
      message: `已用 ${formatBytes(usedBytes)} / ${formatBytes(quotaBytes)}。再存照片可能失败。请先导出备份，再清理旧批次。`,
      actions: [exportAction, purgeAction, photoAction],
    };
  }
  if (pct >= QUOTA_LEVELS.warn) {
    return {
      level: 'warn',
      pct,
      title: `本机空间用了 ${(pct * 100).toFixed(0)}%`,
      message: `已用 ${formatBytes(usedBytes)} / ${formatBytes(quotaBytes)}。还可以继续记，但建议这周导出一次并清理旧批次。`,
      actions: [exportAction, purgeAction],
    };
  }
  return {
    level: 'ok',
    pct,
    title: `本机空间充足（已用 ${(pct * 100).toFixed(1)}%）`,
    message: `${count} 条记录，约 ${formatBytes(usedBytes)}；上限约 ${formatBytes(quotaBytes)}。`,
    actions: [exportAction],
  };
}

/** 照片预算：localStorage 只有几 MB，照片必须限量；IndexedDB 可以放开 */
export function photoBudgetBytes(driverName) {
  if (driverName === 'localstorage') return 2 * 1024 * 1024;
  if (driverName === 'memory') return 24 * 1024 * 1024;
  return 512 * 1024 * 1024;
}

/**
 * 这张照片还存不存得下？
 * @returns {{ allow: boolean, reason: string, budget: number }}
 */
export function planPhotoWrite({ driverName, usedPhotoBytes = 0, photoBytes = 0 }) {
  const budget = photoBudgetBytes(driverName);
  if (photoBytes > budget) {
    return {
      allow: false,
      budget,
      reason: `这张照片压缩后还有 ${formatBytes(photoBytes)}，超过当前存储方式的照片上限（${formatBytes(budget)}）。`,
    };
  }
  if (usedPhotoBytes + photoBytes > budget) {
    return {
      allow: false,
      budget,
      reason: `照片已占 ${formatBytes(usedPhotoBytes)}，再加这张会超过上限 ${formatBytes(budget)}。请先导出并清理旧批次的照片。`,
    };
  }
  return { allow: true, budget, reason: '' };
}

/* ==========================================================================
   2. 驱动
   ========================================================================== */

const PROBE_KEY = '__probe__:1';

/** 内存驱动：永远可用，但刷新就没。只用兜底，用了就必须在界面上喊出来。 */
export function createMemoryDriver({ name = 'memory', label = '内存（刷新后消失）' } = {}) {
  const mem = new Map();
  return {
    name,
    label,
    persistent: false,
    accepts: 'blob',
    async supported() {
      return true;
    },
    async open() {
      await probeWith({
        set: async (k, v) => mem.set(k, v),
        get: async (k) => mem.get(k),
        del: async (k) => mem.delete(k),
      });
    },
    async get(key) {
      const row = mem.get(key);
      return row === undefined ? undefined : row.value;
    },
    async set(key, collection, value) {
      mem.set(key, { collection, value });
    },
    async delete(key) {
      mem.delete(key);
    },
    async keys() {
      return [...mem.keys()];
    },
    async clear() {
      mem.clear();
    },
    async estimate() {
      let used = 0;
      for (const [k, v] of mem) used += estimateBytes(k) + estimateBytes(v);
      return { usedBytes: used, quotaBytes: 0 };
    },
  };
}

/** localStorage 驱动：兼容性最好，但容量只有几 MB，且只能存字符串 */
export function createLocalStorageDriver({
  name = 'localstorage',
  label = '浏览器本地存储（localStorage）',
  prefix = 'shopfloor-qc:',
} = {}) {
  const PREFIX = prefix;
  const ls = () => {
    if (typeof localStorage === 'undefined') throw new Error('这个环境没有 localStorage');
    return localStorage;
  };
  return {
    name,
    label,
    persistent: true,
    accepts: 'text',
    maxRecordBytes: 60 * 1024, // 一条记录别超过 60KB，否则解析会变慢
    async supported() {
      try {
        const s = ls();
        s.setItem(`${PREFIX}__probe`, '1');
        s.removeItem(`${PREFIX}__probe`);
        return true;
      } catch {
        return false;
      }
    },
    async open() {
      const s = ls();
      await probeWith({
        set: async (k, v) => s.setItem(PREFIX + k, JSON.stringify(v)),
        get: async (k) => {
          const raw = s.getItem(PREFIX + k);
          return raw === null ? undefined : JSON.parse(raw);
        },
        del: async (k) => s.removeItem(PREFIX + k),
      });
    },
    async get(key) {
      const raw = ls().getItem(PREFIX + key);
      if (raw === null) return undefined;
      // 落盘时包了一层 { c: 集合, v: 值 }（方便按前缀列出某集合），读出来必须拆掉，
      // 否则上层拿到的是个壳子 —— 记录没有 id、模板没有 items，什么都渲染不出来。
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'v' in parsed) return parsed.v;
      return parsed;
    },
    async set(key, collection, value) {
      try {
        ls().setItem(PREFIX + key, JSON.stringify({ c: collection, v: value }));
      } catch (err) {
        if (isQuotaError(err)) {
          throw new QuotaError(
            '本机存储空间不够，这条记录没存进去。',
            quotaAdvice({ usedBytes: 0, quotaBytes: 0, count: 0 }),
            err,
          );
        }
        throw err;
      }
    },
    async delete(key) {
      ls().removeItem(PREFIX + key);
    },
    async keys() {
      const s = ls();
      const out = [];
      for (let i = 0; i < s.length; i += 1) {
        const k = s.key(i);
        if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
      }
      return out;
    },
    async clear() {
      for (const k of await this.keys()) ls().removeItem(PREFIX + k);
    },
    async estimate() {
      const s = ls();
      let used = 0;
      for (let i = 0; i < s.length; i += 1) {
        const k = s.key(i);
        if (k && k.startsWith(PREFIX)) used += (k.length + (s.getItem(k) || '').length) * 2;
      }
      // 浏览器普遍给 5MB；不知道就是 5MB，宁可报保守值
      return { usedBytes: used, quotaBytes: 5 * 1024 * 1024 };
    },
  };
}

/** IndexedDB 驱动：主用。能直接存 Blob，容量按磁盘给。 */
export function createIndexedDbDriver({
  name = 'indexeddb',
  label = '浏览器本机数据库（IndexedDB）',
  dbName = 'shopfloor-qc',
  storeName = 'kv',
} = {}) {
  let db = null;
  const idb = () => {
    if (typeof indexedDB === 'undefined' || !indexedDB) throw new Error('这个环境没有 IndexedDB');
    return indexedDB;
  };
  const tx = (mode) => db.transaction(storeName, mode).objectStore(storeName);
  const wrap = (req) =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('本机数据库操作失败'));
    });

  return {
    name,
    label,
    persistent: true,
    accepts: 'blob',
    async supported() {
      // 这里只回答「能不能用」，不能抛错——降级链靠它决定下一步
      try {
        return typeof indexedDB !== 'undefined' && indexedDB !== null;
      } catch {
        return false;
      }
    },
    async open() {
      db = await new Promise((resolve, reject) => {
        const req = idb().open(dbName, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(storeName)) {
            const os = d.createObjectStore(storeName, { keyPath: 'key' });
            os.createIndex('collection', 'collection');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error(`打不开本机数据库：${req.error?.message || '未知原因'}`));
        req.onblocked = () => reject(new Error('本机数据库被另一个标签页占用，请关掉其它标签页再试'));
      });
      db.onversionchange = () => {
        db.close();
        db = null;
      };
      await probeWith({
        set: async (k, v) => wrap(tx('readwrite').put({ key: k, collection: '__probe__', value: v })),
        get: async (k) => (await wrap(tx('readonly').get(k)))?.value,
        del: async (k) => wrap(tx('readwrite').delete(k)),
      });
    },
    async get(key) {
      const row = await wrap(tx('readonly').get(key));
      return row === undefined ? undefined : row.value;
    },
    async set(key, collection, value) {
      try {
        await wrap(tx('readwrite').put({ key, collection, value }));
      } catch (err) {
        if (isQuotaError(err)) {
          throw new QuotaError('本机存储空间不够，这条记录没存进去。', null, err);
        }
        throw err;
      }
    },
    async delete(key) {
      await wrap(tx('readwrite').delete(key));
    },
    async keys() {
      const os = tx('readonly');
      const req = os.getAllKeys();
      const all = await wrap(req);
      return all.map((k) => String(k));
    },
    async clear() {
      await wrap(tx('readwrite').clear());
    },
    async estimate() {
      try {
        if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
          const est = await navigator.storage.estimate();
          return { usedBytes: est.usage || 0, quotaBytes: est.quota || 0 };
        }
      } catch {
        /* 拿不到就算了，上层会显示「不提供」 */
      }
      return { usedBytes: 0, quotaBytes: 0 };
    },
  };
}

/** 真写一次、读回来、删掉：避免「open 成功但其实存不进去」的假可用环境 */
async function probeWith(io) {
  await io.set(PROBE_KEY, { ok: true, at: 1 });
  const back = await io.get(PROBE_KEY);
  if (!back || back.ok !== true) throw new Error('存储写入后读不回来');
  await io.del(PROBE_KEY);
}

function isQuotaError(err) {
  if (!err) return false;
  if (err instanceof QuotaError) return true;
  const name = err.name || '';
  const msg = String(err.message || err);
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    /quota|storage.*full|空间不够|已满/i.test(msg)
  );
}
export { isQuotaError };

/* ==========================================================================
   3. 仓库
   ========================================================================== */

export const COLLECTIONS = ['records', 'anomalies', 'templates', 'photos', 'meta'];

/**
 * 建一个仓库。会按顺序挑第一个真正可用的驱动，挑的过程记在 fallbacks 里给界面显示。
 * @param {object} opts { drivers, onEvent }
 */
export async function createStore({ drivers, onEvent = () => {} } = {}) {
  const candidates = drivers && drivers.length ? drivers : [createIndexedDbDriver(), createLocalStorageDriver(), createMemoryDriver()];
  const fallbacks = [];
  let driver = null;

  for (const d of candidates) {
    try {
      if (!(await d.supported())) {
        fallbacks.push({ name: d.name, label: d.label, reason: '这个浏览器不支持' });
        continue;
      }
      await d.open();
      driver = d;
      break;
    } catch (err) {
      fallbacks.push({ name: d.name, label: d.label, reason: err.message || String(err) });
    }
  }

  if (!driver) {
    // 连内存都开不了属于环境彻底坏了，必须炸出来，不能假装能存
    throw new Error(`找不到任何可用的存储方式：${fallbacks.map((f) => `${f.label}（${f.reason}）`).join('；')}`);
  }

  onEvent({ type: 'driver', driver: driver.name, fallbacks });
  const keyOf = (collection, id) => `${collection}:${id}`;
  const cache = new Map();

  async function list(collection) {
    if (cache.has(collection)) return cache.get(collection);
    const keys = (await driver.keys()).filter((k) => k.startsWith(`${collection}:`));
    const rows = [];
    for (const k of keys) {
      const v = await driver.get(k);
      if (v) rows.push(v);
    }
    rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    cache.set(collection, rows);
    return rows;
  }

  async function put(collection, obj) {
    if (!obj || obj.id === undefined) throw new Error('要保存的对象必须带 id');
    const row = toPlain({ ...obj, savedAt: Date.now() });
    try {
      await driver.set(keyOf(collection, obj.id), collection, row);
    } catch (err) {
      // 驱动是插拔的，所以不能用 instanceof 判：第三方驱动抛的依然是原生 DOMException
      if (isQuotaError(err)) {
        const usage = await store.usage();
        // 界面上一律说人话，原始错误挂在 cause 里给排查用
        throw new QuotaError(
          '本机存储空间不够，这条记录没存进去。',
          quotaAdvice({ usedBytes: usage.usedBytes, quotaBytes: usage.quotaBytes, count: usage.count }),
          err,
        );
      }
      throw err;
    }
    const rows = cache.get(collection);
    if (rows) {
      const i = rows.findIndex((r) => r.id === obj.id);
      if (i >= 0) rows[i] = row;
      else rows.unshift(row);
    }
    return row;
  }

  async function putMany(collection, objs = [], { onProgress } = {}) {
    let saved = 0;
    for (const o of objs) {
      await put(collection, o);
      saved += 1;
      if (onProgress) onProgress(saved, objs.length);
    }
    return saved;
  }

  async function remove(collection, id) {
    await driver.delete(keyOf(collection, id));
    const rows = cache.get(collection);
    if (rows) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    }
  }

  async function removeWhere(collection, predicate) {
    const rows = await list(collection);
    const hit = rows.filter(predicate);
    let n = 0;
    for (const r of hit) {
      await remove(collection, r.id);
      n += 1;
    }
    return n;
  }

  async function clear(collection) {
    for (const k of (await driver.keys()).filter((x) => x.startsWith(`${collection}:`))) {
      await driver.delete(k);
    }
    cache.delete(collection);
  }

  async function clearAll() {
    for (const c of COLLECTIONS) await clear(c);
    cache.clear();
  }

  /** 删掉某时间点之前的记录，同时删掉它们的照片与关联异常单的引用 */
  async function purgeBefore(ts, { keepAnomalies = false } = {}) {
    const old = (await list('records')).filter((r) => (r.createdAt || 0) < ts);
    const ids = new Set(old.map((r) => r.id));
    let photos = 0;
    await removeWhere('photos', (p) => {
      const hit = ids.has(p.recordId);
      if (hit) photos += 1;
      return hit;
    });
    for (const r of old) await remove('records', r.id);
    if (!keepAnomalies) {
      await removeWhere('anomalies', (a) => ids.has(a.recordId));
    }
    return { records: old.length, photos };
  }

  async function usage() {
    let est = { usedBytes: 0, quotaBytes: 0 };
    try {
      est = (await driver.estimate()) || est;
    } catch {
      /* 拿不到就用估算 */
    }
    let count = 0;
    if (!est.usedBytes) {
      for (const c of COLLECTIONS) {
        if (c === 'meta') continue;
        const rows = await list(c);
        count += rows.length;
        for (const r of rows) est.usedBytes += estimateBytes(r);
      }
    } else {
      count =
        (await list('records')).length + (await list('anomalies')).length + (await list('photos')).length;
    }
    return {
      driver: driver.name,
      persistent: driver.persistent,
      usedBytes: est.usedBytes,
      quotaBytes: est.quotaBytes,
      count,
      advice: quotaAdvice({ usedBytes: est.usedBytes, quotaBytes: est.quotaBytes, count }),
    };
  }

  async function exportAll() {
    const out = { app: 'shopfloor-qc', version: 1, exportedAt: Date.now(), data: {} };
    for (const c of COLLECTIONS) {
      if (c === 'photos') continue; // 照片单独处理，见 exportRecordsWithPhotos
      out.data[c] = await list(c);
    }
    return out;
  }

  async function importAll(payload, { mode = 'merge' } = {}) {
    if (!payload || payload.app !== 'shopfloor-qc' || !payload.data) {
      throw new Error('这不是本产品导出的备份文件');
    }
    if (mode === 'replace') await clearAll();
    let n = 0;
    for (const c of COLLECTIONS) {
      const rows = payload.data[c];
      if (!Array.isArray(rows)) continue;
      n += await putMany(c, rows);
    }
    return n;
  }

  const store = {
    backend: driver.name,
    backendLabel: driver.label,
    persistent: driver.persistent,
    accepts: driver.accepts,
    fallbacks,
    list,
    put,
    putMany,
    remove,
    removeWhere,
    clear,
    clearAll,
    purgeBefore,
    usage,
    exportAll,
    importAll,
    invalidate: (collection) => cache.delete(collection),
    refresh: (collection) => {
      cache.delete(collection);
      return list(collection);
    },
  };
  return store;
}
