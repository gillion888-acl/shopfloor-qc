/**
 * 车间质检本 · 存储层测试
 * 这一层的失败方式最要命：数据静静地没了，而车间以为还在。
 * 所以重点测三件事：能不能降级、降级有没有说清楚、空间不够时有没有给出路。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createStore,
  createMemoryDriver,
  createLocalStorageDriver,
  createIndexedDbDriver,
  estimateBytes,
  formatBytes,
  planPhotoWrite,
  photoBudgetBytes,
  quotaAdvice,
  toPlain,
  QuotaError,
  COLLECTIONS,
} from './store.js';
import { normalizeTemplates, buildDemoHistory, judgeRecord, passingValues, judgeItem, buildAnomaly } from './qc.js';

const templates = normalizeTemplates(
  JSON.parse(readFileSync(new URL('./templates.json', import.meta.url), 'utf8')).templates,
);
const NOW = new Date(2026, 9, 18, 17, 0, 0).getTime();

/** 造一个可控的假驱动，用来精确制造「不支持 / 打不开 / 写不下」这三种坏情况 */
function fakeDriver({ name = 'fake', supported = true, openError = null, putError = null, persistent = true, accepts = 'blob' } = {}) {
  const mem = new Map();
  return {
    name,
    label: `假驱动 ${name}`,
    persistent,
    accepts,
    async supported() {
      return supported;
    },
    async open() {
      if (openError) throw new Error(openError);
    },
    async get(key) {
      const row = mem.get(key);
      return row === undefined ? undefined : row.value;
    },
    async set(key, collection, value) {
      if (putError) throw putError;
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
      return { usedBytes: used, quotaBytes: 5 * 1024 * 1024 };
    },
  };
}

const quotaErr = () => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });

/* ==========================================================================
   字节与容量口径
   ========================================================================== */

test('estimateBytes: 字符串按 UTF-16、Blob 按 size、对象递归累加', () => {
  assert.equal(estimateBytes('abcd'), 8);
  assert.equal(estimateBytes(1), 8);
  assert.equal(estimateBytes(null), 0);
  assert.equal(estimateBytes(undefined), 0);
  assert.ok(estimateBytes({ a: 'x', b: [1, 2, 3] }) > 60);
  // 带 Blob 的环境（Node 18+ 有 Blob）
  assert.equal(estimateBytes(new Blob([new Uint8Array(1000)])), 1000);
});

test('estimateBytes: 循环引用不会死循环', () => {
  const a = { name: 'a' };
  a.self = a;
  assert.ok(estimateBytes(a) > 0);
});

test('formatBytes: 车间看得懂的单位', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(formatBytes(-1), '—');
});

test('toPlain: 把响应式代理拆成能落盘的普通对象', () => {
  const inner = new Proxy([{ name: '外径' }], {});
  assert.throws(() => structuredClone(inner), '代理本来就克隆不了——这正是落盘失败的真实原因');

  const record = { id: 'r-1', results: inner };
  const plain = toPlain(record);
  assert.deepEqual(structuredClone(plain), { id: 'r-1', results: [{ name: '外径' }] });
  assert.notEqual(plain, record);
  assert.ok(!plain.results.hasOwnProperty.call(plain.results, '__v_raw'), '拆出来的不能再是代理');
});

test('toPlain: Blob 与 Date 原样保留（照片靠它），循环引用不死循环', () => {
  const blob = new Blob([new Uint8Array(8)]);
  const at = new Date(1700000000000);
  const plain = toPlain({ id: 'p-1', data: blob, createdAt: at });
  assert.equal(plain.data, blob);
  assert.ok(plain.createdAt instanceof Date);
  const cyc = { id: 'x' };
  cyc.self = cyc;
  const plainCyc = toPlain(cyc);
  assert.equal(plainCyc.self, plainCyc, '循环引用照着原样接回去，不爆栈也不丢字段');
});

test('put: 传进去的是响应式代理数组也能存下来（否则现场保存会整个失败）', async () => {
  const store = await createStore({ drivers: [createMemoryDriver()] });
  const reactive = new Proxy(
    {
      id: 'r-proxy',
      createdAt: 1,
      verdict: 'fail',
      results: new Proxy([{ itemId: 'i1', name: '外径', status: 'fail', value: '10.62' }], {}),
    },
    {},
  );
  await store.put('records', reactive);
  const rows = await store.list('records');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].results[0].name, '外径');
  assert.ok(structuredClone(rows[0]), '落盘后的东西必须是可再克隆的普通数据');
});

test('quotaAdvice: 75% 提醒、90% 报警，且都给得出下一步动作', () => {
  const ok = quotaAdvice({ usedBytes: 1e6, quotaBytes: 1e8, count: 12 });
  assert.equal(ok.level, 'ok');
  assert.ok(ok.actions.some((a) => a.id === 'export'));

  const warn = quotaAdvice({ usedBytes: 8e6, quotaBytes: 1e7, count: 900 });
  assert.equal(warn.level, 'warn');
  assert.match(warn.title, /80%/);
  assert.ok(warn.actions.some((a) => a.id === 'purge'), '要给出清理路径');

  const critical = quotaAdvice({ usedBytes: 9.5e6, quotaBytes: 1e7, count: 1500 });
  assert.equal(critical.level, 'critical');
  assert.ok(critical.actions.some((a) => a.id === 'purge'));
  assert.ok(critical.actions.some((a) => a.id === 'photos'));
});

test('quotaAdvice: 浏览器不报容量时不假装知道，仍给导出建议', () => {
  const unknown = quotaAdvice({ usedBytes: 2048, quotaBytes: 0, count: 3 });
  assert.equal(unknown.level, 'unknown');
  assert.equal(unknown.pct, null);
  assert.ok(unknown.actions.some((a) => a.id === 'export'));
  assert.match(unknown.message, /2\.0 KB/);
});

test('planPhotoWrite: 压缩后太大 / 累计超出照片预算时拒绝写入并说明原因', () => {
  assert.equal(photoBudgetBytes('localstorage'), 2 * 1024 * 1024);
  assert.ok(photoBudgetBytes('indexeddb') > photoBudgetBytes('localstorage'), 'IndexedDB 应该能放更多照片');

  const big = planPhotoWrite({ driverName: 'localstorage', photoBytes: 3 * 1024 * 1024 });
  assert.equal(big.allow, false);
  assert.match(big.reason, /超过当前存储方式的照片上限/);

  const full = planPhotoWrite({ driverName: 'localstorage', usedPhotoBytes: 1.9 * 1024 * 1024, photoBytes: 300 * 1024 });
  assert.equal(full.allow, false);
  assert.match(full.reason, /照片已占|先导出并清理/);

  const fine = planPhotoWrite({ driverName: 'indexeddb', usedPhotoBytes: 40 * 1024 * 1024, photoBytes: 200 * 1024 });
  assert.equal(fine.allow, true);
  assert.equal(fine.reason, '');
});

/* ==========================================================================
   降级
   ========================================================================== */

test('createStore: 首选驱动可用就直接用它，不做多余的试探', async () => {
  const store = await createStore({ drivers: [fakeDriver({ name: 'indexeddb' }), createMemoryDriver()] });
  assert.equal(store.backend, 'indexeddb');
  assert.equal(store.persistent, true);
  assert.deepEqual(store.fallbacks, []);
});

test('createStore: 首选驱动「不支持」时降级，并记下原因给界面显示', async () => {
  const store = await createStore({
    drivers: [fakeDriver({ name: 'indexeddb', supported: false }), fakeDriver({ name: 'localstorage' })],
  });
  assert.equal(store.backend, 'localstorage');
  assert.equal(store.fallbacks.length, 1);
  assert.equal(store.fallbacks[0].name, 'indexeddb');
  assert.match(store.fallbacks[0].reason, /不支持/);
});

test('createStore: 驱动「打得开但存不进」时也要降级（open 里会真写一次做探针）', async () => {
  const store = await createStore({
    drivers: [
      fakeDriver({ name: 'indexeddb', openError: '本机数据库写入后读不回来' }),
      fakeDriver({ name: 'localstorage' }),
    ],
  });
  assert.equal(store.backend, 'localstorage');
  assert.match(store.fallbacks[0].reason, /读不回来/);
});

test('createStore: 全部降级到内存时必须自报家门「刷新就没」', async () => {
  const store = await createStore({
    drivers: [
      fakeDriver({ name: 'indexeddb', openError: '被另一个标签页占用' }),
      fakeDriver({ name: 'localstorage', supported: false }),
      createMemoryDriver(),
    ],
  });
  assert.equal(store.backend, 'memory');
  assert.equal(store.persistent, false, '内存模式必须能被上层识别成「不持久」');
  assert.equal(store.fallbacks.length, 2);
  assert.ok(store.fallbacks.some((f) => /占用/.test(f.reason)));
});

test('createStore: 连内存都用不了就抛错，不假装能存', async () => {
  await assert.rejects(
    () => createStore({ drivers: [fakeDriver({ name: 'indexeddb', supported: false })] }),
    /找不到任何可用的存储方式/,
  );
});

test('真实驱动在 Node 下都自报不支持（这就是降级链的入口）', async () => {
  assert.equal(await createIndexedDbDriver().supported(), false, 'Node 里没有 indexedDB');
  assert.equal(await createLocalStorageDriver().supported(), false, 'SDK 里没有 localStorage');
  assert.equal(await createMemoryDriver().supported(), true);
});

/** Node 里没有 localStorage，就补一个最小实现，用来真跑 localStorage 驱动（不 mock 驱动本身） */
async function withFakeLocalStorage(fn) {
  const map = new Map();
  const shim = {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(String(k), String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
  };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true, writable: true });
  try {
    // 必须 await：不 await 的话 finally 会在异步体跑之前就把 shim 拆掉
    return await fn(shim, map);
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete globalThis.localStorage;
  }
}

test('localStorage 驱动：存进去再读出来是原样的对象，不是 { c, v } 壳子', async () => {
  await withFakeLocalStorage(async () => {
    const driver = createLocalStorageDriver();
    assert.equal(await driver.supported(), true);
    await driver.open();

    await driver.set('templates:t1', 'templates', { id: 't1', items: [{ name: '外径' }] });
    const back = await driver.get('templates:t1');
    assert.equal(back.id, 't1', '读回来必须能直接拿到 id');
    assert.ok(Array.isArray(back.items), '模板的 items 还在（少了它整个界面都渲染不出来）');
    assert.equal(back.items[0].name, '外径');
    assert.deepEqual(await driver.keys(), ['templates:t1']);
    await driver.delete('templates:t1');
    assert.equal(await driver.get('templates:t1'), undefined);
  });
});

test('localStorage 驱动：整条仓库链走通（写入 → 冷读 → 列表 → 清理）', async () => {
  await withFakeLocalStorage(async () => {
    const store = await createStore({ drivers: [createLocalStorageDriver(), createMemoryDriver()] });
    assert.equal(store.backend, 'localstorage');
    const demo = buildDemoHistory({ templates, now: NOW });
    await store.putMany('records', demo.records.slice(0, 3));
    await store.put('anomalies', demo.anomalies[0]);
    await store.put('templates', templates[0]);

    // 冷读：绕开内存缓存，模拟「关掉浏览器再打开」
    store.invalidate('records');
    const rows = await store.list('records');
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => typeof r.id === 'string' && r.id.length), '每条记录都要有 id');
    assert.ok(rows[0].results.length > 0, '检查项结果要跟着一起回来');

    store.invalidate('templates');
    const t = (await store.list('templates'))[0];
    assert.equal(t.items.length, 8, '模板的检查项一个都不能少');

    store.invalidate('anomalies');
    const a = (await store.list('anomalies'))[0];
    assert.ok(a.level && a.failedItems.length, '异常单的内容也要完整');

    const u = await store.usage();
    assert.ok(u.usedBytes > 0);
    assert.equal(u.quotaBytes, 5 * 1024 * 1024, 'localStorage 按 5MB 报，宁可保守');

    await store.clearAll();
    store.invalidate('records');
    assert.equal((await store.list('records')).length, 0);
  });
});

test('createStore: 降级到只认字符串的驱动时，照片口径也一起切到「文本 + 小预算」', async () => {
  const ls = createLocalStorageDriver();
  assert.equal(ls.accepts, 'text', 'localStorage 只能存字符串');
  assert.equal(createIndexedDbDriver().accepts, 'blob', 'IndexedDB 能直接存 Blob');
  const store = await createStore({
    drivers: [fakeDriver({ name: 'indexeddb', supported: false }), fakeDriver({ name: 'localstorage', accepts: 'text' })],
  });
  assert.equal(store.backend, 'localstorage');
  assert.equal(store.accepts, 'text');
  assert.equal(store.persistent, true, '降级到 localStorage 仍然是持久的，只有内存驱动不是');
  assert.equal(photoBudgetBytes(store.backend) < photoBudgetBytes('indexeddb'), true, '预算跟着降');
});

/* ==========================================================================
   读写、导出、清理
   ========================================================================== */

test('put / list / remove / clear：增删查改都对，且按时间倒序', async () => {
  const store = await createStore({ drivers: [createMemoryDriver()] });
  await store.put('records', { id: 'r-1', createdAt: 1000, batchNo: 'B-1' });
  await store.put('records', { id: 'r-2', createdAt: 3000, batchNo: 'B-2' });
  await store.put('records', { id: 'r-3', createdAt: 2000, batchNo: 'B-3' });
  const rows = await store.list('records');
  assert.deepEqual(rows.map((r) => r.id), ['r-2', 'r-3', 'r-1']);
  assert.ok(rows[0].savedAt > 0, '落盘时会补一个保存时间');

  await store.put('records', { id: 'r-3', createdAt: 2000, batchNo: 'B-3-改' });
  assert.equal((await store.list('records')).find((r) => r.id === 'r-3').batchNo, 'B-3-改');
  assert.equal((await store.list('records')).length, 3, '同 id 覆盖不新增');

  await store.remove('records', 'r-1');
  assert.equal((await store.list('records')).length, 2);
  await store.clear('records');
  assert.equal((await store.list('records')).length, 0);
});

test('put: 没有 id 的对象直接拒绝，避免存进去再也查不到', async () => {
  const store = await createStore({ drivers: [createMemoryDriver()] });
  await assert.rejects(() => store.put('records', { batchNo: 'B-没有主键' }), /必须带 id/);
});

test('put: 空间不够时抛 QuotaError，并带上「先导出再清理」的建议', async () => {
  const store = await createStore({
    drivers: [fakeDriver({ name: 'localstorage', putError: quotaErr() })],
  });
  await assert.rejects(
    () => store.put('records', { id: 'r-1', createdAt: 1 }),
    (err) => {
      assert.ok(err instanceof QuotaError);
      assert.equal(err.name, 'QuotaError');
      assert.match(err.message, /空间不够/);
      assert.ok(err.advice && Array.isArray(err.advice.actions));
      assert.ok(err.advice.actions.some((a) => a.id === 'export'));
      return true;
    },
  );
});

test('unknown 类错误不被当成配额问题吞掉', async () => {
  const store = await createStore({ drivers: [fakeDriver({ name: 'x', putError: new Error('磁盘坏了') })] });
  await assert.rejects(
    () => store.put('records', { id: 'r-9' }),
    (err) => {
      assert.ok(!(err instanceof QuotaError));
      assert.match(err.message, /磁盘坏了/);
      return true;
    },
  );
});

test('整个示例台账写进去再读出来，条数一致（关机重开也不丢的前提）', async () => {
  const store = await createStore({ drivers: [createMemoryDriver()] });
  const demo = buildDemoHistory({ templates, now: NOW });
  await store.putMany('records', demo.records);
  await store.putMany('anomalies', demo.anomalies);
  await store.putMany('templates', templates);
  assert.equal((await store.list('records')).length, 20);
  assert.equal((await store.list('anomalies')).length, 4);
  assert.equal((await store.list('templates')).length, 3);
});

test('purgeBefore: 只删旧记录，连带删掉它们的照片，新记录一根汗毛不动', async () => {
  const store = await createStore({ drivers: [createMemoryDriver()] });
  const demo = buildDemoHistory({ templates, now: NOW });
  await store.putMany('records', demo.records);
  await store.putMany('anomalies', demo.anomalies);
  for (const r of demo.records.slice(0, 3)) {
    await store.put('photos', { id: `p-${r.id}`, recordId: r.id, createdAt: r.createdAt, size: 1024 });
  }
  const cutoff = NOW - 4 * 86400000;
  const res = await store.purgeBefore(cutoff);
  const left = await store.list('records');
  assert.equal(res.records, demo.records.filter((r) => r.createdAt < cutoff).length);
  assert.equal(res.photos, 3);
  assert.equal(left.length, 20 - res.records);
  assert.ok(left.every((r) => r.createdAt >= cutoff), '新记录必须还在');
  assert.equal((await store.list('photos')).length, 0);
  assert.ok(
    (await store.list('anomalies')).every((a) => left.some((r) => r.id === a.recordId)),
    '异常单不能留下「记录已经没了」的孤儿',
  );
});

test('exportAll / importAll：备份能原样还原，且会拒绝不认识的备份文件', async () => {
  const store = await createStore({ drivers: [createMemoryDriver()] });
  const demo = buildDemoHistory({ templates, now: NOW });
  await store.putMany('records', demo.records);
  await store.putMany('anomalies', demo.anomalies);
  await store.putMany('templates', templates);

  const dump = await store.exportAll();
  assert.equal(dump.app, 'shopfloor-qc');
  assert.equal(dump.data.records.length, 20);
  assert.ok(!dump.data.photos, '照片单独处理，不塞进 JSON 备份');

  const fresh = await createStore({ drivers: [createMemoryDriver()] });
  const n = await fresh.importAll(dump);
  assert.equal(n, 27, '20 笔记录 + 4 张异常单 + 3 套模板');
  assert.equal((await fresh.list('records')).length, 20);

  await assert.rejects(() => fresh.importAll({ app: '别的产品', data: {} }), /不是本产品导出的备份文件/);
});

test('usage(): 汇总条数、用量与建议，界面直接照着渲染', async () => {
  const store = await createStore({ drivers: [createMemoryDriver()] });
  const demo = buildDemoHistory({ templates, now: NOW });
  await store.putMany('records', demo.records);
  const u = await store.usage();
  assert.equal(u.driver, 'memory');
  assert.equal(u.count, 20);
  assert.ok(u.usedBytes > 0);
  assert.ok(['ok', 'warn', 'critical', 'unknown'].includes(u.advice.level));
});

test('COLLECTIONS: 导出的收藏夹固定，加一处漏一处都会被这条测试抓住', () => {
  assert.deepEqual(COLLECTIONS, ['records', 'anomalies', 'templates', 'photos', 'meta']);
});

/* ==========================================================================
   端到端：判定 → 建单 → 落库 → 查询（不碰浏览器）
   ========================================================================== */

test('把「超限 → 建异常单 → 落库」跑通一次', async () => {
  const store = await createStore({ drivers: [createMemoryDriver()] });
  const template = templates.find((t) => t.id === 'tpl-electronics');
  const values = { ...passingValues(template), [template.items.find((i) => i.name === '通电亮灯').id]: false };
  const judged = judgeRecord(template, values);
  assert.equal(judged.verdict, 'fail');

  const record = {
    id: 'r-e2e-1',
    createdAt: NOW,
    workOrder: 'MO-261018-01',
    batchNo: 'B-261018-01',
    machine: '组装线 A',
    inspector: '王建国',
    templateId: template.id,
    templateName: template.name,
    results: judged.results,
    verdict: judged.verdict,
    photos: [],
  };
  const anomaly = buildAnomaly(record, judged.failed);
  record.anomalyId = anomaly.id;
  record.anomalyLevel = anomaly.level;

  await store.put('records', record);
  await store.put('anomalies', anomaly);

  const found = await store.list('records');
  assert.equal(found.length, 1);
  assert.equal(found[0].anomalyLevel, 'scrap');

  // 事后按批号翻记录：能翻到是谁检的、量到多少
  const hit = (await store.list('records')).find((r) => r.batchNo === 'B-261018-01');
  assert.equal(hit.inspector, '王建国');
  const bad = hit.results.find((x) => x.status === 'fail');
  assert.equal(bad.name, '通电亮灯');
  assert.equal(bad.value, false);
  assert.match(bad.reason, /要求是「是」/);
});
