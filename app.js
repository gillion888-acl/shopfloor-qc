/**
 * 车间质检本 · 应用层
 *
 * 界面：Vue 3 + Element Plus（本地内嵌，不依赖 CDN）
 * 逻辑：qc.js（判定 / 分级 / 追溯 / 报表）、store.js（本机存储与降级）
 * 本文件只负责状态、事件与渲染，不含业务规则。
 *
 * 设计原则（都是车间逼出来的）：
 *   1. 首屏一句话讲清「给谁、在什么环境下用」，3 步流程 + 一颗示例按钮；
 *   2. 现场优先：大字号、大按钮、数字键盘（inputmode）、不合格项整行标红；
 *   3. 任何一步失败都要说人话：没网照记、存不下要说清怎么救。
 */

import {
  ITEM_TYPES,
  SEVERITIES,
  FREQUENCIES,
  LEVELS,
  LEVEL_MAP,
  classifyComplaint,
  buildAnomaly,
  buildDemoHistory,
  buildReport,
  closeAnomaly,
  defaultSeverity,
  formatDateTime,
  judgeRecord,
  newId,
  nominalValue,
  normalizeTemplates,
  passingValues,
  queryRecords,
  recordsToCsv,
  recordsToLongCsv,
  anomaliesToCsv,
  reportToMarkdown,
  round,
  specText,
  suggestLevel,
  summarizeRecord,
} from './qc.js';
import {
  createStore,
  createIndexedDbDriver,
  createLocalStorageDriver,
  createMemoryDriver,
  formatBytes,
  planPhotoWrite,
  quotaAdvice,
} from './store.js';

const { createApp, ref, reactive, computed, onMounted, watch } = window.Vue;
const { ElMessage, ElMessageBox } = window.ElementPlus;

/* ==========================================================================
   常量
   ========================================================================== */

const SHIFTS = ['早班', '中班', '夜班'];

/** 主题偏好：故意不用存储层的 shopfloor-qc: 前缀，免得被「清空本机数据」一起清掉 */
const THEME_KEY = 'shopfloor-qc-theme';

const LEVEL_COLOR = { scrap: '#c01048', isolate: '#b54708', rework: '#0b6bcb', concession: '#0f766e' };

const VIEWS = [
  { id: 'home', label: '开始', icon: 'HomeFilled' },
  { id: 'inspect', label: '现场检验', icon: 'EditPen' },
  { id: 'anomaly', label: '异常处理', icon: 'WarningFilled' },
  { id: 'trace', label: '追溯查询', icon: 'Search' },
  { id: 'report', label: '报表', icon: 'DataAnalysis' },
  { id: 'template', label: '检查项模板', icon: 'Files' },
  { id: 'data', label: '数据与设置', icon: 'Setting' },
];

const DEFAULT_AI = {
  aiEnabled: false,
  aiEndpoint: 'https://api.openai.com/v1/chat/completions',
  aiModel: 'gpt-4o-mini',
  aiKey: '',
};

/* ==========================================================================
   应用
   ========================================================================== */

const app = createApp({
  setup() {
    /* ---------------- 基础状态 ---------------- */

    const view = ref('home');
    const loading = ref(true);
    const bootError = ref('');
    const theme = ref('light');
    const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine);
    const now = ref(Date.now());
    const busy = ref(false);

    const storeRef = ref(null);
    const storage = reactive({ backend: '', label: '', persistent: true, accepts: 'blob', fallbacks: [] });
    const usage = reactive({ usedBytes: 0, quotaBytes: 0, count: 0, advice: quotaAdvice({}) });

    const templates = ref([]);
    const records = ref([]);
    const anomalies = ref([]);
    const photos = ref([]);
    const settings = reactive({ ...DEFAULT_AI, purgeDays: 30 });
    const photoUrls = reactive({});
    const photoWarnings = ref([]);

    /* ---------------- 派生数据 ---------------- */

    const openAnomalies = computed(() => anomalies.value.filter((a) => !a.closed));
    const anomalyMap = computed(() => Object.fromEntries(anomalies.value.map((a) => [a.id, a])));
    const photosByRecord = computed(() => {
      const m = {};
      for (const p of photos.value) {
        if (!m[p.recordId]) m[p.recordId] = [];
        m[p.recordId].push(p);
      }
      return m;
    });
    const photosBytes = computed(() =>
      photos.value.reduce((s, p) => s + (typeof p.data === 'string' ? p.data.length * 2 : p.size || 0), 0),
    );
    const usagePct = computed(() => {
      if (!usage.quotaBytes) return null;
      return Math.min(100, Math.round((usage.usedBytes / usage.quotaBytes) * 100));
    });

    const uniq = (arr) => [...new Set(arr.filter(Boolean))];
    const machines = computed(() => uniq(records.value.map((r) => r.machine)));
    const inspectors = computed(() => uniq(records.value.map((r) => r.inspector)));
    const workOrders = computed(() => uniq(records.value.map((r) => r.workOrder)));
    const batches = computed(() => uniq(records.value.map((r) => r.batchNo)));
    const templateById = (id) => templates.value.find((t) => t.id === id);

    /** 内置三套按固定顺序摆，其余按名字排 —— 不然存储读回来的顺序是按键名排的，用户看着莫名其妙 */
    const BUILTIN_ORDER = ['tpl-metal', 'tpl-plastic', 'tpl-electronics'];
    function sortTemplates(list) {
      const rank = (t) => {
        const i = BUILTIN_ORDER.indexOf(t.id);
        return i === -1 ? 99 : i;
      };
      return [...list].sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name), 'zh'));
    }

    const backendShort = computed(
      () => ({ indexeddb: 'IndexedDB', localstorage: 'localStorage', memory: '内存（临时）' })[storage.backend] || storage.backend,
    );

    /**
     * 驱动链。正常就是 IndexedDB → localStorage → 内存。
     * 加 ?storage=local|memory 可以强制只用某一种 —— 现场排查「这台平板存不进去」时很管用，
     * 也让人能亲眼看到降级之后的界面长什么样。
     */
    const forcedStorage = (() => {
      try {
        return new URLSearchParams(location.search).get('storage') || '';
      } catch {
        return '';
      }
    })();

    function driverChain() {
      if (forcedStorage === 'local') return [createLocalStorageDriver(), createMemoryDriver()];
      if (forcedStorage === 'memory') return [createMemoryDriver()];
      return [createIndexedDbDriver(), createLocalStorageDriver(), createMemoryDriver()];
    }

    const weekReport = computed(() =>
      buildReport({ records: records.value, anomalies: anomalies.value, granularity: 'week', now: now.value }),
    );

    /* ---------------- 启动 ---------------- */

    onMounted(async () => {
      try {
        const saved = localStorage.getItem(THEME_KEY);
        if (saved) theme.value = saved;
      } catch {
        /* 私密模式下读不到主题就用默认的，不影响记录 */
      }
      applyTheme();
      if (typeof window !== 'undefined') {
        window.addEventListener('online', () => {
          online.value = true;
        });
        window.addEventListener('offline', () => {
          online.value = false;
        });
      }
      await boot();
    });

    function applyTheme() {
      document.documentElement.setAttribute('data-theme', theme.value);
      try {
        localStorage.setItem(THEME_KEY, theme.value);
      } catch {
        /* 存不下主题无关紧要 */
      }
    }

    function toggleTheme() {
      theme.value = theme.value === 'light' ? 'dark' : 'light';
      applyTheme();
    }

    async function boot() {
      loading.value = true;
      bootError.value = '';
      try {
        const st = await createStore({ drivers: driverChain() });
        storeRef.value = st;
        storage.backend = st.backend;
        storage.label = st.backendLabel;
        storage.persistent = st.persistent;
        storage.accepts = st.accepts;
        storage.fallbacks = st.fallbacks;

        templates.value = sortTemplates(await st.list('templates'));
        records.value = [...(await st.list('records'))];
        anomalies.value = [...(await st.list('anomalies'))];
        photos.value = [...(await st.list('photos'))];

        const metaRow = (await st.list('meta')).find((m) => m.id === 'settings');
        if (metaRow) {
          for (const k of Object.keys(DEFAULT_AI)) {
            if (metaRow[k] !== undefined) settings[k] = metaRow[k];
          }
          if (metaRow.purgeDays) settings.purgeDays = metaRow.purgeDays;
        }

        await seedTemplatesIfEmpty();
        await refreshUsage();

        if (!inspect.templateId && templates.value.length) inspect.templateId = templates.value[0].id;
      } catch (err) {
        bootError.value = `打不开本机存储：${err.message}。请改用 Chrome / Edge 打开；如果是用 file:// 直接打开的，请用本地静态服务或线上地址。`;
      } finally {
        loading.value = false;
      }
    }

    /** 第一次打开时把 templates.json 里的三套示例模板写进本机库（之后就是用户自己的了） */
    async function seedTemplatesIfEmpty() {
      if (templates.value.length || !storeRef.value) return;
      try {
        const res = await fetch('./templates.json', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list = normalizeTemplates(data.templates || []);
        if (!list.length) throw new Error('文件里没有模板');
        await storeRef.value.putMany('templates', list);
        templates.value = sortTemplates(await storeRef.value.list('templates'));
      } catch (err) {
        bootError.value = `读不到内置检查项模板（templates.json）：${err.message}。可以在「检查项模板」页自己新建一套，功能不受影响。`;
      }
    }

    async function refreshUsage() {
      if (!storeRef.value) return;
      const u = await storeRef.value.usage();
      Object.assign(usage, u);
    }

    async function refreshAll() {
      if (!storeRef.value) return;
      records.value = [...(await storeRef.value.refresh('records'))];
      anomalies.value = [...(await storeRef.value.refresh('anomalies'))];
      photos.value = [...(await storeRef.value.refresh('photos'))];
      templates.value = sortTemplates(await storeRef.value.refresh('templates'));
      await refreshUsage();
      now.value = Date.now();
    }

    /* ==========================================================================
       现场检验
       ========================================================================== */

    const inspect = reactive({
      templateId: '',
      workOrder: '',
      batchNo: '',
      machine: '',
      inspector: '',
      shift: '早班',
      qty: '',
      note: '',
    });
    const values = reactive({});
    const pendingPhotos = ref([]);
    const photoBusy = ref(false);
    const saving = ref(false);
    const lastSaved = ref(null);
    const pendingRecord = ref(null);

    const anomalyDialog = reactive({
      open: false,
      level: 'rework',
      suggested: '',
      suggestedReason: '',
      reason: '',
      handler: '',
      approvedBy: '',
      failed: [],
    });

    const activeTemplate = computed(() => templateById(inspect.templateId) || templates.value[0] || null);
    const judged = computed(() =>
      activeTemplate.value ? judgeRecord(activeTemplate.value, values) : { results: [], failed: [], missing: [], counted: 0, verdict: 'incomplete' },
    );
    const resultMap = computed(() => Object.fromEntries(judged.value.results.map((r) => [r.itemId, r])));
    const progress = computed(() => {
      const tpl = activeTemplate.value;
      if (!tpl) return { required: 0, filled: 0, total: 0 };
      const required = tpl.items.filter((i) => i.required !== false);
      return {
        required: required.length,
        filled: required.filter((i) => {
          const v = values[i.id];
          if (i.type === 'bool') return v === true || v === false;
          return v !== undefined && v !== null && String(v).trim() !== '';
        }).length,
        total: tpl.items.length,
      };
    });
    const headerMissing = computed(() => {
      const miss = [];
      if (!inspect.workOrder.trim()) miss.push('工单');
      if (!inspect.batchNo.trim()) miss.push('批号');
      if (!inspect.machine.trim()) miss.push('机台');
      if (!inspect.inspector.trim()) miss.push('检验员');
      return miss;
    });
    const canSave = computed(
      () => !saving.value && headerMissing.value.length === 0 && progress.value.filled === progress.value.required && progress.value.required > 0,
    );

    function pickTemplate(id) {
      inspect.templateId = id;
      clearValues();
      lastSaved.value = null;
    }

    function clearValues() {
      for (const k of Object.keys(values)) delete values[k];
      clearPendingPhotos();
      inspect.note = '';
    }

    function startNewInspection() {
      view.value = 'inspect';
    }

    function severityLabel(it) {
      const s = defaultSeverity(it);
      return s === 'critical' ? '关键项' : s === 'major' ? '主要项' : '次要项';
    }

    function severityTagClass(it) {
      const s = defaultSeverity(it);
      return s === 'critical' ? 'crit' : s === 'major' ? 'major' : 'minor';
    }

    function resultOf(itemId) {
      return resultMap.value[itemId] || { status: 'empty', label: '未填', reason: '' };
    }

    function itemClass(it) {
      const r = resultOf(it.id).status;
      return r === 'fail' ? 'is-fail' : r === 'pass' ? 'is-pass' : r === 'invalid' ? 'is-fail' : 'is-empty';
    }

    function itemStep(it) {
      const hasMin = Number.isFinite(it.min);
      const hasMax = Number.isFinite(it.max);
      let s = hasMin && hasMax ? (it.max - it.min) / 20 : hasMax ? Math.abs(it.max) / 50 : 0.1;
      if (!(s > 0)) s = 0.1;
      return round(s, 3);
    }

    function bump(it, dir) {
      const cur = Number(String(values[it.id] ?? '').replace(/,/g, ''));
      const base = Number.isFinite(cur) ? cur : nominalValue(it);
      values[it.id] = round(base + dir * itemStep(it), 3);
    }

    function fillNominal(it) {
      values[it.id] = nominalValue(it);
    }

    /** 键盘/扫描枪友好：回车跳到下一个输入框 */
    function focusNext() {
      const nodes = [...document.querySelectorAll('.item [data-field]')];
      const idx = nodes.indexOf(document.activeElement);
      const next = nodes[idx + 1];
      if (next) {
        next.focus();
        if (next.select) next.select();
      }
    }

    /* ---------------- 照片 ---------------- */

    async function loadImage(file) {
      if (typeof createImageBitmap === 'function') return createImageBitmap(file);
      return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
          URL.revokeObjectURL(url);
          resolve(img);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('这张图片读不出来'));
        };
        img.src = url;
      });
    }

    /** 本机压缩：最长边 1280、JPEG 0.72 —— 车间平板拍的 4MB 照片压到 200KB 左右 */
    async function compressImage(file, { maxEdge = 1280, quality = 0.72 } = {}) {
      const bmp = await loadImage(file);
      const sw = bmp.width || 1280;
      const sh = bmp.height || 960;
      const scale = Math.min(1, maxEdge / Math.max(sw, sh));
      const w = Math.max(1, Math.round(sw * scale));
      const h = Math.max(1, Math.round(sh * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) throw new Error('压缩失败');
      return { blob, width: w, height: h };
    }

    async function addFiles(files) {
      const list = [...files].filter((f) => f && f.type.startsWith('image/'));
      if (!list.length) {
        ElMessage.warning('只收照片（jpg / png / heic 截图都行）');
        return;
      }
      photoBusy.value = true;
      try {
        for (const f of list) {
          const { blob, width, height } = await compressImage(f);
          pendingPhotos.value = [
            ...pendingPhotos.value,
            {
              id: newId('p'),
              name: f.name || '现场照片',
              originalSize: f.size,
              size: blob.size,
              width,
              height,
              blob,
              url: URL.createObjectURL(blob),
            },
          ];
        }
        ElMessage.success(`已加入 ${list.length} 张照片（本机压缩后只存在这台设备里）`);
      } catch (err) {
        ElMessage.error(`照片处理失败：${err.message}`);
      } finally {
        photoBusy.value = false;
      }
    }

    function onPickPhotos(event) {
      const files = event.target.files;
      if (files && files.length) addFiles(files);
      if (event.target) event.target.value = '';
    }

    function onDropPhotos(event) {
      const dt = event.dataTransfer;
      if (dt && dt.files && dt.files.length) addFiles(dt.files);
    }

    function removePendingPhoto(id) {
      const p = pendingPhotos.value.find((x) => x.id === id);
      if (p) URL.revokeObjectURL(p.url);
      pendingPhotos.value = pendingPhotos.value.filter((x) => x.id !== id);
    }

    function clearPendingPhotos() {
      for (const p of pendingPhotos.value) URL.revokeObjectURL(p.url);
      pendingPhotos.value = [];
      photoWarnings.value = [];
    }

    function blobToDataURL(blob) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error('照片转文本失败'));
        fr.readAsDataURL(blob);
      });
    }

    /**
     * 照片有两种存法：IndexedDB 直接存 Blob，localStorage 只能存 dataURL 字符串。
     * Blob 要在渲染前换成 objectURL（渲染里做这件事会引发重复渲染），所以统一在这里预生成。
     */
    function ensurePhotoUrls() {
      for (const p of photos.value) {
        if (typeof p.data === 'string' || !p.data) continue;
        if (photoUrls[p.id]) continue;
        try {
          photoUrls[p.id] = URL.createObjectURL(p.data);
        } catch {
          /* 坏掉的照片不该拖垮整页 */
        }
      }
    }

    watch(photos, ensurePhotoUrls, { immediate: true, deep: false });

    function photoSrc(p) {
      if (!p) return '';
      return typeof p.data === 'string' ? p.data : photoUrls[p.id] || '';
    }

    /** 存照片：存不下就记下原因，绝不让照片把记录本身拖垮 */
    async function persistPhoto(recordId, p) {
      const st = storeRef.value;
      const data = st.accepts === 'blob' ? p.blob : await blobToDataURL(p.blob);
      const bytes = typeof data === 'string' ? data.length * 2 : p.blob.size || 0;
      const plan = planPhotoWrite({ driverName: st.backend, usedPhotoBytes: photosBytes.value, photoBytes: bytes });
      if (!plan.allow) {
        photoWarnings.value = [...photoWarnings.value, `「${p.name}」没有保存：${plan.reason}`];
        return null;
      }
      const row = {
        id: p.id,
        recordId,
        createdAt: Date.now(),
        name: p.name,
        size: p.blob.size,
        originalSize: p.originalSize,
        type: 'image/jpeg',
        width: p.width,
        height: p.height,
        data,
      };
      await storeRef.value.put('photos', row);
      photos.value = [...(await storeRef.value.list('photos'))];
      return { id: row.id, name: row.name, size: row.size, width: row.width, height: row.height, type: row.type };
    }

    async function removePhoto(photoId) {
      const p = photos.value.find((x) => x.id === photoId);
      if (p && photoUrls[p.id]) {
        URL.revokeObjectURL(photoUrls[p.id]);
        delete photoUrls[p.id];
      }
      await storeRef.value.remove('photos', photoId);
      photos.value = [...(await storeRef.value.list('photos'))];
      await refreshUsage();
    }

    /* ---------------- 保存一笔 ---------------- */

    async function saveInspection({ autoAnomaly = false } = {}) {
      const tpl = activeTemplate.value;
      if (!tpl) {
        ElMessage.warning('先在「检查项模板」里建一套检查项');
        return;
      }
      if (headerMissing.value.length) {
        ElMessage.warning(`还差：${headerMissing.value.join('、')}`);
        return;
      }
      const j = judged.value;
      if (j.missing.length || j.invalid.length) {
        const names = [...j.missing.map((m) => m.name), ...j.invalid.map((m) => m.name)];
        ElMessage.warning(`这些检查项还没填对：${names.join('、')}`);
        return;
      }

      saving.value = true;
      photoWarnings.value = [];
      try {
        const record = {
          id: newId('r'),
          createdAt: Date.now(),
          workOrder: inspect.workOrder.trim(),
          batchNo: inspect.batchNo.trim(),
          machine: inspect.machine.trim(),
          inspector: inspect.inspector.trim(),
          shift: inspect.shift,
          qty: Number(String(inspect.qty).replace(/[^\d.]/g, '')) || null,
          templateId: tpl.id,
          templateName: tpl.name,
          results: j.results,
          counted: j.counted,
          failedCount: j.failed.length,
          verdict: j.verdict,
          note: inspect.note.trim(),
          photos: [],
          anomalyId: '',
          anomalyLevel: '',
        };

        const metas = [];
        for (const p of pendingPhotos.value) {
          const saved = await persistPhoto(record.id, p);
          if (saved) metas.push(saved);
        }
        record.photos = metas;

        await storeRef.value.put('records', record);
        records.value = [...(await storeRef.value.list('records'))];
        await refreshUsage();

        if (j.failed.length) {
          // 超限 → 立刻开异常单。先把建议等级摆出来，让人决定，而不是系统自己拍板。
          showSaved(record, null);
          openAnomalyFor(record, { autoConfirm: autoAnomaly });
          return;
        }

        showSaved(record, null);
        ElMessage.success('这一笔已存在本机');
      } catch (err) {
        handleSaveError(err);
      } finally {
        saving.value = false;
      }
    }

    /** 把「建议等级 + 超限项」摆到对话框里等人确认（现场保存时与事后补开都用它） */
    function openAnomalyFor(record, { autoConfirm = false } = {}) {
      const failed = (record.results || []).filter((r) => r.status === 'fail');
      if (!failed.length) return;
      const sug = suggestLevel(failed);
      pendingRecord.value = record;
      anomalyDialog.failed = failed;
      anomalyDialog.suggested = sug.level;
      anomalyDialog.suggestedReason = sug.reason;
      anomalyDialog.level = sug.level;
      anomalyDialog.reason = sug.reason;
      anomalyDialog.handler = record.inspector || '';
      anomalyDialog.approvedBy = '';
      anomalyDialog.open = true;
      if (autoConfirm) confirmAnomaly({ silent: true });
    }

    function cancelAnomaly() {
      anomalyDialog.open = false;
      const rec = pendingRecord.value;
      pendingRecord.value = null;
      if (rec) showSaved(rec, null);
      ElMessage.info('记录已保存，异常单还没开 —— 在「异常处理」页可以补开');
    }

    function handleSaveError(err) {
      if (err && err.advice) {
        ElMessageBox.alert(
          `${err.message}\n\n现在用了 ${formatBytes(err.advice.usedBytes || 0)}，上限约 ${formatBytes(err.advice.quotaBytes || 0)}。\n${err.advice.message}`,
          '本机空间不够了',
          { confirmButtonText: '去导出并清理', callback: () => (view.value = 'data') },
        ).catch(() => {});
        usage.advice = err.advice;
      } else {
        ElMessage.error(`没存进去：${err.message}`);
      }
    }

    async function confirmAnomaly({ silent = false } = {}) {
      const record = pendingRecord.value;
      if (!record) return;
      try {
        const anomaly = buildAnomaly(record, anomalyDialog.failed, {
          level: anomalyDialog.level,
          reason: anomalyDialog.reason,
          handler: anomalyDialog.handler,
          handledAt: anomalyDialog.handler ? Date.now() : null,
          approvedBy: anomalyDialog.approvedBy,
        });
        await storeRef.value.put('anomalies', anomaly);
        const updated = { ...record, anomalyId: anomaly.id, anomalyLevel: anomaly.level };
        await storeRef.value.put('records', updated);
        records.value = [...(await storeRef.value.list('records'))];
        anomalies.value = [...(await storeRef.value.list('anomalies'))];
        await refreshUsage();
        anomalyDialog.open = false;
        pendingRecord.value = null;
        showSaved(updated, anomaly);
        if (photoWarnings.value.length) {
          ElMessageBox.alert(photoWarnings.value.join('\n'), '照片没能全部保存', { confirmButtonText: '知道了' }).catch(() => {});
        }
        if (!silent) ElMessage.warning('已开异常单，记得去「异常处理」跟进');
      } catch (err) {
        handleSaveError(err);
      }
    }

    function showSaved(record, anomaly) {
      lastSaved.value = {
        record,
        anomaly,
        summary: summarizeRecord(record),
        levelLabel: anomaly ? LEVEL_MAP[anomaly.level].label : '',
      };
      clearValues();
      inspect.batchNo = '';
      inspect.note = '';
    }

    /** 下一笔：保留工单/机台/检验员，只清批号与测量值 —— 现场是连着检的 */
    function nextInspection() {
      lastSaved.value = null;
      if (inspect.workOrder && inspect.batchNo === '') {
        const n = records.value.filter((r) => r.workOrder === inspect.workOrder).length + 1;
        inspect.batchNo = `${inspect.workOrder.replace(/^MO-/, 'B-')}-${String(n).padStart(2, '0')}`;
      }
    }

    /* ---------------- 示例工单 ---------------- */

    const demoBusy = ref(false);

    async function runDemo() {
      if (!storeRef.value) return;
      demoBusy.value = true;
      try {
        // 1) 补一份 6 天的示例台账（只补一次，标了 demo，可一键清掉）
        if (!records.value.some((r) => r.demo)) {
          const demo = buildDemoHistory({ templates: templates.value, now: Date.now() });
          await storeRef.value.putMany('records', demo.records);
          await storeRef.value.putMany('anomalies', demo.anomalies);
        }
        // 2) 真的跑一次现场检验：走的是跟人工一模一样的保存路径
        const tpl = templateById('tpl-plastic') || templates.value[1] || templates.value[0];
        inspect.templateId = tpl.id;
        clearValues();
        const vals = passingValues(tpl);
        const weight = tpl.items.find((i) => i.name === '射出件重量');
        if (weight) vals[weight.id] = 13.05; // 上限 12.90 → 超 0.15 g，主要项超限 → 隔离
        Object.assign(values, vals);
        const day = new Date();
        const stamp = `${String(day.getFullYear()).slice(2)}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`;
        const seq = String(records.value.filter((r) => r.batchNo.includes(stamp)).length + 1).padStart(2, '0');
        inspect.workOrder = `MO-${stamp}-${seq}`;
        inspect.batchNo = `B-${stamp}-${seq}`;
        inspect.machine = '射出机 #1';
        inspect.inspector = '陈志明';
        inspect.shift = '早班';
        inspect.qty = 900;
        inspect.note = '示例：换料后首件，重量偏上限';
        await saveInspection({ autoAnomaly: true });
        await refreshAll();
        view.value = 'report';
        ElMessage.success('示例已就绪：1 笔现场检验 + 6 天示例台账，可直接看报表与追溯');
      } catch (err) {
        handleSaveError(err);
      } finally {
        demoBusy.value = false;
      }
    }

    async function clearDemoData() {
      try {
        await ElMessageBox.confirm('清掉演示用的示例台账（你自己录的不会动），确定？', '清除示例数据', {
          confirmButtonText: '清除示例',
          cancelButtonText: '不动',
          type: 'warning',
        });
      } catch {
        return;
      }
      const demoIds = new Set(records.value.filter((r) => r.demo).map((r) => r.id));
      await storeRef.value.removeWhere('records', (r) => demoIds.has(r.id));
      await storeRef.value.removeWhere('anomalies', (a) => demoIds.has(a.recordId) || String(a.id).startsWith('demo-'));
      await refreshAll();
      ElMessage.success('示例数据已清除');
    }

    /* ==========================================================================
       异常处理
       ========================================================================== */

    const anomalyFilter = ref('open');
    const aiText = ref('');
    const aiResult = ref(null);
    const aiBusy = ref(false);
    const aiError = ref('');

    const visibleAnomalies = computed(() => {
      const list = [...anomalies.value].sort((a, b) => a.createdAt - b.createdAt);
      if (anomalyFilter.value === 'open') return list.filter((a) => !a.closed);
      if (anomalyFilter.value === 'closed') return list.filter((a) => a.closed).reverse();
      return list.reverse();
    });

    /** 不合格但没开异常单的记录 —— 现场有人跳过了，品质主管要看得见 */
    const orphanFails = computed(() => records.value.filter((r) => r.verdict === 'fail' && !r.anomalyId));

    function hoursOpen(a) {
      const end = a.closed ? a.closedAt : Date.now();
      return round((end - a.createdAt) / 3600000, 1);
    }

    function isOverdue(a) {
      return !a.closed && Date.now() - a.createdAt > 24 * 3600000;
    }

    const closeDialog = reactive({ open: false, id: '', closureNote: '', handler: '' });

    function askClose(a) {
      closeDialog.open = true;
      closeDialog.id = a.id;
      closeDialog.closureNote = '';
      closeDialog.handler = a.handler || '';
    }

    async function doClose() {
      const a = anomalies.value.find((x) => x.id === closeDialog.id);
      if (!a) return;
      try {
        const closed = closeAnomaly(a, {
          closureNote: closeDialog.closureNote,
          handler: closeDialog.handler,
          closedAt: Date.now(),
        });
        await storeRef.value.put('anomalies', closed);
        anomalies.value = [...(await storeRef.value.list('anomalies'))];
        closeDialog.open = false;
        ElMessage.success('异常单已关闭');
      } catch (err) {
        ElMessage.warning(err.message);
      }
    }

    async function assignHandler(a) {
      try {
        const { value } = await ElMessageBox.prompt('谁负责处理这张异常单？', '指派处置人', {
          inputValue: a.handler || '',
          confirmButtonText: '指派',
          cancelButtonText: '取消',
          inputPlaceholder: '例如：黄志强（品质主管）',
        });
        const updated = { ...a, handler: String(value || '').trim(), handledAt: Date.now() };
        await storeRef.value.put('anomalies', updated);
        anomalies.value = [...(await storeRef.value.list('anomalies'))];
      } catch {
        /* 取消就取消 */
      }
    }

    const anomPhotos = computed(() => {
      const out = {};
      for (const a of anomalies.value) {
        const rec = records.value.find((r) => r.id === a.recordId);
        out[a.id] = rec ? photosByRecord.value[rec.id] || [] : [];
      }
      return out;
    });

    function classifyByRule() {
      const items = activeTemplate.value ? activeTemplate.value.items : templates.value.flatMap((t) => t.items);
      aiResult.value = { mode: 'rule', ...classifyComplaint(aiText.value, items) };
      aiError.value = '';
    }

    async function classifyByAi() {
      if (!settings.aiEnabled || !settings.aiKey) {
        aiError.value = '没有启用 AI 或没填 Key，已用离线规则归类。';
        classifyByRule();
        return;
      }
      aiBusy.value = true;
      aiError.value = '';
      try {
        const items = activeTemplate.value ? activeTemplate.value.items : templates.value.flatMap((t) => t.items);
        const names = items.map((i) => i.name).join('、');
        const res = await fetch(settings.aiEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.aiKey}` },
          body: JSON.stringify({
            model: settings.aiModel,
            temperature: 0,
            messages: [
              {
                role: 'system',
                content: `你是制造厂品质助理。只能从这些检查项里挑：${names}。只输出 JSON，格式 {"items":["检查项名"],"reason":"一句话"}`,
              },
              { role: 'user', content: `客户投诉：${aiText.value}` },
            ],
          }),
        });
        if (!res.ok) throw new Error(`接口返回 ${res.status}`);
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content || '';
        const match = text.match(/\{[\s\S]*\}/);
        const parsed = match ? JSON.parse(match[0]) : { items: [], reason: text };
        const matches = (parsed.items || [])
          .map((n) => items.find((i) => i.name === n))
          .filter(Boolean)
          .map((i) => ({ itemId: i.id, name: i.name, hit: i.name, exact: true }));
        aiResult.value = { mode: 'ai', matches, category: matches[0]?.name || '', confidence: matches.length ? 0.75 : 0, note: parsed.reason || '' };
        if (!matches.length) aiError.value = 'AI 没给出可用的检查项，建议用离线规则的结果。';
      } catch (err) {
        aiError.value = `AI 调用失败（${err.message}），已退回离线规则。`;
        classifyByRule();
      } finally {
        aiBusy.value = false;
      }
    }

    /* ==========================================================================
       追溯查询
       ========================================================================== */

    const traceFilter = reactive({
      batchNo: '',
      workOrder: '',
      machine: '',
      inspector: '',
      verdict: 'all',
      level: 'all',
      keyword: '',
    });
    const dateFrom = ref('');
    const dateTo = ref('');

    const traceResults = computed(() =>
      queryRecords(
        records.value,
        {
          ...traceFilter,
          from: dateFrom.value ? new Date(`${dateFrom.value}T00:00:00`).getTime() : 0,
          to: dateTo.value ? new Date(`${dateTo.value}T23:59:59`).getTime() : 0,
        },
        { anomalyMap: anomalyMap.value },
      ),
    );

    const traceRows = computed(() => traceResults.value.map(summarizeRecord));
    const detail = ref(null);
    const detailOpen = ref(false);

    function openDetail(record) {
      detail.value = record;
      detailOpen.value = true;
    }

    function closeDetail() {
      detailOpen.value = false;
      detail.value = null;
    }

    function resetTrace() {
      Object.assign(traceFilter, { batchNo: '', workOrder: '', machine: '', inspector: '', verdict: 'all', level: 'all', keyword: '' });
      dateFrom.value = '';
      dateTo.value = '';
    }

    /** 客诉最常见的查法：先看最近 7 天 */
    function lastWeek() {
      const d = new Date();
      const to = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      d.setDate(d.getDate() - 6);
      dateFrom.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      dateTo.value = to;
    }

    /** 表格里显示实测值：是/否要写中文，没填要写「—」，别让人看到 false 和 undefined */
    function valueText(row) {
      if (!row) return '—';
      if (row.type === 'bool') return row.value === true ? '是' : row.value === false ? '否' : '—';
      if (row.value === null || row.value === undefined || String(row.value).trim() === '') return '—';
      return String(row.value);
    }

    function csvName(prefix, ext = 'csv') {
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      return `${prefix}-${stamp}.${ext}`;
    }

    function download(name, text, type = 'text/csv;charset=utf-8') {
      const blob = new Blob([text], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    }

    function exportTraceCsv() {
      if (!traceResults.value.length) {
        ElMessage.warning('当前条件下没有记录，先放宽条件再导出');
        return;
      }
      download(csvName('质检记录'), recordsToCsv(traceResults.value));
      ElMessage.success(`已导出 ${traceResults.value.length} 条记录（CSV，Excel 可直接打开）`);
    }

    function exportTraceLongCsv() {
      if (!traceResults.value.length) {
        ElMessage.warning('当前条件下没有记录');
        return;
      }
      download(csvName('质检记录-逐项'), recordsToLongCsv(traceResults.value));
    }

    function exportAnomalyCsv() {
      if (!anomalies.value.length) {
        ElMessage.warning('还没有异常单');
        return;
      }
      download(csvName('异常单'), anomaliesToCsv(anomalies.value));
    }

    function exportJsonBackup() {
      storeRef.value
        .exportAll()
        .then((dump) => {
          download(csvName('质检本备份', 'json'), JSON.stringify(dump, null, 2), 'application/json;charset=utf-8');
          ElMessage.success('已导出 JSON 备份（照片体积大，不含在内）');
        })
        .catch((err) => ElMessage.error(`导出失败：${err.message}`));
    }

    const importBusy = ref(false);

    async function onImportBackup(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      importBusy.value = true;
      try {
        const payload = JSON.parse(await file.text());
        const n = await storeRef.value.importAll(payload, { mode: 'merge' });
        await refreshAll();
        ElMessage.success(`已导入 ${n} 条数据（同名记录以备份里的为准）`);
      } catch (err) {
        ElMessage.error(`导入失败：${err.message}`);
      } finally {
        importBusy.value = false;
        if (event.target) event.target.value = '';
      }
    }

    /* ==========================================================================
       报表
       ========================================================================== */

    const granularity = ref('week');
    const report = computed(() =>
      buildReport({ records: records.value, anomalies: anomalies.value, granularity: granularity.value, now: now.value }),
    );
    const reportMd = computed(() => reportToMarkdown(report.value, { records: records.value, anomalies: anomalies.value }));

    /** 每日批次柱状图：合格 + 不合格堆叠，手画 SVG */
    const barChart = computed(() => {
      const days = report.value.byDay;
      const W = 700;
      const H = 210;
      const padTop = 26;
      const padBottom = 40;
      const x0 = 34;
      const x1 = W - 10;
      const plotH = H - padTop - padBottom;
      const maxV = Math.max(1, ...days.map((d) => d.batches));
      const step = (x1 - x0) / Math.max(1, days.length);
      const barW = Math.min(58, step * 0.56);
      const bars = days.map((d, i) => {
        const cx = x0 + step * i + step / 2;
        const h = (d.batches / maxV) * plotH;
        const fh = (d.fail / maxV) * plotH;
        const base = padTop + plotH;
        return {
          key: d.key,
          label: d.label,
          batches: d.batches,
          fail: d.fail,
          x: cx - barW / 2,
          y: base - h,
          w: barW,
          h,
          fy: base - h,
          fh,
          cx,
          ty: base - h - 7,
          ly: base + 18,
        };
      });
      const ticks = [];
      const tickStep = Math.max(1, Math.ceil(maxV / 4));
      for (let v = 0; v <= maxV; v += tickStep) {
        const y = padTop + plotH - (v / maxV) * plotH;
        ticks.push({ v, y });
      }
      return { W, H, bars, ticks, padTop, plotH, x0, x1, baseline: padTop + plotH };
    });

    const topMax = computed(() => Math.max(1, ...report.value.topDefects.map((d) => d.count)));

    const levelSegs = computed(() => {
      const total = LEVELS.reduce((s, l) => s + (report.value.levels[l.value] || 0), 0);
      if (!total) return [];
      return LEVELS.filter((l) => report.value.levels[l.value]).map((l) => ({
        key: l.value,
        label: l.label,
        count: report.value.levels[l.value],
        pct: ((report.value.levels[l.value] / total) * 100).toFixed(1),
        color: LEVEL_COLOR[l.value],
      }));
    });

    function setGranularity(g) {
      granularity.value = g;
      now.value = Date.now();
    }

    function pctText(v) {
      return `${(Number(v || 0) * 100).toFixed(1)}%`;
    }

    function printReport() {
      window.print();
    }

    function exportReportMd() {
      download(csvName('质检报表', 'md'), reportMd.value, 'text/markdown;charset=utf-8');
    }

    /* ==========================================================================
       模板编辑
       ========================================================================== */

    const editing = ref(null);
    const itemDialog = reactive({ open: false, index: -1, draft: {} });

    function blankItem() {
      return {
        id: newId('it'),
        name: '',
        type: 'number',
        unit: '',
        min: null,
        max: null,
        expect: '',
        okOptions: [],
        options: [],
        required: true,
        frequency: '每 2 小时',
        severity: 'major',
        hint: '',
      };
    }

    function startEditTemplate(t) {
      editing.value = JSON.parse(JSON.stringify(t));
    }

    async function newTemplate() {
      const base = editing.value
        ? JSON.parse(JSON.stringify(editing.value))
        : { id: '', name: '', industry: '', note: '', items: [] };
      editing.value = {
        ...base,
        id: newId('tpl'),
        name: `${base.name || '自定义模板'} 副本`,
        builtin: false,
        items: (base.items || []).map((i) => ({ ...i, id: newId('it') })),
      };
      ElMessage.info('已基于当前模板建了一份副本，改完点「保存模板」');
    }

    function blankTemplate() {
      editing.value = { id: newId('tpl'), name: '新模板', industry: '', builtin: false, note: '', items: [blankItem()] };
    }

    function editItem(index) {
      const item = editing.value.items[index];
      itemDialog.index = index;
      itemDialog.draft = {
        ...item,
        min: Number.isFinite(item.min) ? item.min : null,
        max: Number.isFinite(item.max) ? item.max : null,
        okOptionsText: (item.okOptions || []).join(' / '),
        optionsText: (item.options || []).join(' / '),
      };
      itemDialog.open = true;
    }

    function addItem() {
      const item = blankItem();
      editing.value.items = [...editing.value.items, item];
      editItem(editing.value.items.length - 1);
    }

    function saveItem() {
      const d = itemDialog.draft;
      if (!d.name || !String(d.name).trim()) {
        ElMessage.warning('检查项要有个名字');
        return;
      }
      const split = (s) => String(s || '').split('/').map((x) => x.trim()).filter(Boolean);
      const next = {
        ...d,
        name: String(d.name).trim(),
        unit: String(d.unit || '').trim(),
        min: d.type === 'number' && d.min !== null && d.min !== '' ? Number(d.min) : null,
        max: d.type === 'number' && d.max !== null && d.max !== '' ? Number(d.max) : null,
        okOptions: split(d.okOptionsText),
        options: split(d.optionsText).length ? split(d.optionsText) : split(d.okOptionsText),
      };
      delete next.okOptionsText;
      delete next.optionsText;
      if (next.type === 'number' && next.min !== null && next.max !== null && next.min > next.max) {
        ElMessage.warning('下限比上限还大，检查一下');
        return;
      }
      const items = [...editing.value.items];
      items[itemDialog.index] = next;
      editing.value.items = items;
      itemDialog.open = false;
    }

    function removeItem(index) {
      editing.value.items = editing.value.items.filter((_, i) => i !== index);
    }

    function moveItem(index, dir) {
      const items = [...editing.value.items];
      const target = index + dir;
      if (target < 0 || target >= items.length) return;
      [items[index], items[target]] = [items[target], items[index]];
      editing.value.items = items;
    }

    async function saveTemplate() {
      if (!editing.value.name.trim()) {
        ElMessage.warning('模板要有个名字');
        return;
      }
      if (!editing.value.items.length) {
        ElMessage.warning('至少要有一个检查项');
        return;
      }
      await storeRef.value.put('templates', { ...editing.value, builtin: false });
      templates.value = sortTemplates(await storeRef.value.list('templates'));
      if (inspect.templateId === editing.value.id) inspect.templateId = editing.value.id;
      ElMessage.success(`模板「${editing.value.name}」已保存（${editing.value.items.length} 项）`);
    }

    async function removeTemplate(t) {
      try {
        await ElMessageBox.confirm(`删除模板「${t.name}」？已经录好的记录不受影响（记录里存了当时的检查项）。`, '删除模板', {
          confirmButtonText: '删除',
          cancelButtonText: '取消',
          type: 'warning',
        });
      } catch {
        return;
      }
      await storeRef.value.remove('templates', t.id);
      templates.value = sortTemplates(await storeRef.value.list('templates'));
      if (editing.value && editing.value.id === t.id) editing.value = null;
      if (inspect.templateId === t.id) inspect.templateId = templates.value[0]?.id || '';
      ElMessage.success('模板已删除');
    }

    function exportTemplate() {
      const t = editing.value || activeTemplate.value;
      if (!t) {
        ElMessage.warning('先选一套模板');
        return;
      }
      download(`${t.name}.json`, JSON.stringify({ app: 'shopfloor-qc', templates: [t] }, null, 2), 'application/json;charset=utf-8');
    }

    async function onImportTemplate(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const list = normalizeTemplates(data.templates || (Array.isArray(data) ? data : [data]));
        if (!list.length) throw new Error('文件里没有模板');
        for (const t of list) {
          await storeRef.value.put('templates', { ...t, builtin: false, id: templateById(t.id) ? newId('tpl') : t.id });
        }
        templates.value = sortTemplates(await storeRef.value.list('templates'));
        ElMessage.success(`已导入 ${list.length} 套模板`);
      } catch (err) {
        ElMessage.error(`导入模板失败：${err.message}`);
      } finally {
        if (event.target) event.target.value = '';
      }
    }

    /* ==========================================================================
       数据与设置
       ========================================================================== */

    const purgeDays = ref(30);

    async function saveSettings() {
      await storeRef.value.put('meta', { id: 'settings', ...settings });
      ElMessage.success('设置已保存在本机');
    }

    function exportAllCsv() {
      if (!records.value.length) {
        ElMessage.warning('还没有记录');
        return;
      }
      download(csvName('全部质检记录'), recordsToCsv(records.value));
    }

    async function doPurge() {
      const days = Number(purgeDays.value) || 30;
      const cutoff = Date.now() - days * 86400000;
      const willDrop = records.value.filter((r) => r.createdAt < cutoff).length;
      if (!willDrop) {
        ElMessage.info(`没有 ${days} 天以前的记录，不用清理`);
        return;
      }
      try {
        await ElMessageBox.confirm(
          `将删除 ${willDrop} 笔 ${days} 天前的记录、它们的照片与关联异常单。\n建议先点「导出全部数据」存一份到 U 盘。`,
          '导出后清理旧批次',
          { confirmButtonText: '先导出再清理', cancelButtonText: '再想想', type: 'warning' },
        );
      } catch {
        return;
      }
      exportJsonBackup();
      const res = await storeRef.value.purgeBefore(cutoff);
      await refreshAll();
      ElMessage.success(`已清理 ${res.records} 笔记录、${res.photos} 张照片`);
    }

    async function doClearAll() {
      try {
        await ElMessageBox.confirm(
          '这会删掉本机上全部质检记录、异常单和照片（模板保留）。确定前请先导出备份。',
          '清空本机数据',
          { confirmButtonText: '我已导出，清空', cancelButtonText: '取消', type: 'error' },
        );
      } catch {
        return;
      }
      for (const id of Object.keys(photoUrls)) {
        URL.revokeObjectURL(photoUrls[id]);
        delete photoUrls[id];
      }
      await storeRef.value.clearAll();
      await refreshAll();
      ElMessage.success('本机数据已清空（模板已保留）');
    }

    async function dropOldPhotos() {
      const keep = 7 * 86400000;
      const cutoff = Date.now() - keep;
      const n = await storeRef.value.removeWhere('photos', (p) => (p.createdAt || 0) < cutoff);
      for (const r of records.value) {
        if ((r.createdAt || 0) < cutoff && (r.photos || []).length) {
          await storeRef.value.put('records', { ...r, photos: [] });
        }
      }
      await refreshAll();
      ElMessage.success(n ? `已删掉 ${n} 张 7 天前的照片（记录仍在）` : '没有 7 天前的照片');
    }

    async function testAi() {
      if (!settings.aiKey) {
        ElMessage.warning('先填 Key');
        return;
      }
      aiBusy.value = true;
      try {
        const res = await fetch(settings.aiEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.aiKey}` },
          body: JSON.stringify({ model: settings.aiModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }),
        });
        ElMessage[res.ok ? 'success' : 'error'](res.ok ? '接口通了' : `接口返回 ${res.status}`);
      } catch (err) {
        ElMessage.error(`连不上：${err.message}`);
      } finally {
        aiBusy.value = false;
      }
    }

    /* ==========================================================================
       杂项
       ========================================================================== */

    function go(v) {
      view.value = v;
      if (v === 'report') now.value = Date.now();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    const demoSample = computed(() => {
      const tpl = templateById('tpl-plastic') || activeTemplate.value;
      if (!tpl) return '';
      return tpl.items
        .slice(0, 3)
        .map((i) => `${i.name} ${specText(i)}`)
        .join('；');
    });

    return {
      // 基础
      view, loading, bootError, theme, online, now, busy, storeRef, forcedStorage,
      storage, backendShort, usage, usagePct, settings, photoWarnings, photoUrls,
      templates, records, anomalies, photos, photosBytes,
      // 派生
      openAnomalies, anomalyMap, photosByRecord, machines, inspectors, workOrders, batches, templateById, weekReport,
      // 常量
      VIEWS, LEVELS, LEVEL_MAP, LEVEL_COLOR, SHIFTS, ITEM_TYPES, SEVERITIES, FREQUENCIES,
      // 检验
      inspect, values, pendingPhotos, photoBusy, saving, lastSaved, anomalyDialog,
      activeTemplate, judged, resultMap, progress, headerMissing, canSave,
      pickTemplate, clearValues, startNewInspection, severityLabel, severityTagClass, resultOf, itemClass,
      itemStep, bump, fillNominal, focusNext, onPickPhotos, onDropPhotos, removePendingPhoto,
      saveInspection, confirmAnomaly, nextInspection, demoBusy, runDemo, clearDemoData, demoSample,
      // 异常
      anomalyFilter, visibleAnomalies, orphanFails, openAnomalyFor, cancelAnomaly,
      hoursOpen, isOverdue, closeDialog, askClose, doClose, assignHandler,
      anomPhotos, aiText, aiResult, aiBusy, aiError, classifyByRule, classifyByAi,
      // 追溯
      traceFilter, dateFrom, dateTo, lastWeek, traceResults, traceRows, detail, detailOpen, openDetail, closeDetail,
      resetTrace, exportTraceCsv, exportTraceLongCsv, exportAnomalyCsv, removePhoto, photoSrc, valueText,
      formatDateTime, formatBytes,
      // 报表
      granularity, report, reportMd, barChart, topMax, levelSegs, setGranularity, pctText, printReport, exportReportMd,
      // 模板
      editing, itemDialog, startEditTemplate, newTemplate, blankTemplate, editItem, addItem, saveItem,
      removeItem, moveItem, saveTemplate, removeTemplate, exportTemplate, onImportTemplate,
      specText, defaultSeverity, nominalValue,
      // 数据
      purgeDays, saveSettings, exportAllCsv, exportJsonBackup, onImportBackup, doPurge, doClearAll, dropOldPhotos,
      testAi, importBusy, refreshAll,
      // 杂项
      go, toggleTheme, download, csvName, round,
    };
  },

  template: `
<div>
  <!-- ============ 顶栏 ============ -->
  <header class="top">
    <div class="brand">
      <span class="mark" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 13l4.5 4.5L19 7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </span>
      <span>
        <span class="name">车间质检本</span>
        <span class="sub">离线记录，异常追溯，只存本机</span>
      </span>
    </div>
    <div class="topright">
      <el-tag v-if="storage.backend" :type="storage.persistent ? 'success' : 'danger'" effect="dark" size="large">
        本机存储：{{ backendShort }}
      </el-tag>
      <el-tag :type="online ? 'info' : 'success'" effect="plain" size="large">
        {{ online ? '当前联网（不影响记录）' : '已离线，照常记录' }}
      </el-tag>
      <el-button text @click="toggleTheme">
        {{ theme === 'dark' ? '切到亮色' : '切到暗色' }}
      </el-button>
    </div>
  </header>

  <!-- ============ 导航 ============ -->
  <nav class="nav" aria-label="主导航">
    <button v-for="v in VIEWS" :key="v.id" :aria-current="view === v.id ? 'page' : undefined" @click="go(v.id)">
      <el-icon><component :is="v.icon" /></el-icon>
      <span>{{ v.label }}</span>
      <span v-if="v.id === 'anomaly' && openAnomalies.length" class="count">{{ openAnomalies.length }}</span>
    </button>
  </nav>

  <main class="wrap">
    <!-- ============ 加载 / 启动错误 ============ -->
    <div v-if="loading" class="card">
      <h2>正在打开本机质检台账…</h2>
      <p class="hint">本产品不需要联网，这一步只是读一下这台设备上已经存好的记录。</p>
      <el-skeleton :rows="3" animated />
    </div>

    <template v-else>
      <div v-if="bootError" class="banner fail" role="alert">
        <div>
          <div class="bt">有一件事没做成</div>
          <div class="bd">{{ bootError }}</div>
        </div>
      </div>

      <div v-if="forcedStorage" class="banner info">
        <div>
          <div class="bt">当前是排查模式：URL 参数强制指定了存储方式（{{ forcedStorage }}）</div>
          <div class="bd">现在存在 {{ backendShort }}。去掉网址后面的 ?storage=… 就会回到正常的 IndexedDB。</div>
        </div>
      </div>

      <div v-if="!storage.persistent && storage.backend" class="banner fail" role="alert">
        <div>
          <div class="bt">⚠ 现在这一层存不住东西：一刷新记录就没了</div>
          <div class="bd">
            当前用的是 {{ backendShort }}，不是磁盘。请改用标准 Chrome / Edge 打开，
            并先去「数据与设置」导出备份。现场开工前必须先确认这一条。
          </div>
        </div>
      </div>

      <div v-if="storage.fallbacks && storage.fallbacks.length" class="banner warn">
        <div>
          <div class="bt">存储方式已自动降级（数据仍在，但要知情）</div>
          <div class="bd">
            本来想用 {{ storage.fallbacks[0].label }}，但它用不了：{{ storage.fallbacks[0].reason }}。现在改存在 {{ storage.label }}。
          </div>
        </div>
      </div>

      <div v-if="usage.advice && (usage.advice.level === 'warn' || usage.advice.level === 'critical')" class="banner" :class="usage.advice.level === 'critical' ? 'fail' : 'warn'">
        <div>
          <div class="bt">{{ usage.advice.title }}</div>
          <div class="bd">{{ usage.advice.message }}</div>
          <div class="row" style="margin-top:8px">
            <el-button v-for="a in usage.advice.actions" :key="a.id" size="small" @click="go('data')">{{ a.label }}</el-button>
          </div>
        </div>
      </div>

      <!-- ==================================================================
           开始
           ================================================================== -->
      <template v-if="view === 'home'">
        <section class="card hero">
          <h1>车间没网络，也要一笔记下来</h1>
          <p class="lead">
            检验员在机台边用平板逐项记录，超限当场标红、当场开异常单；出了客诉，按批号或工单一查，
            就知道当时是谁检的、量到多少、那批用了什么料。全部存在这台设备里，不联网、不上传、也不需要 IT 装服务器。
          </p>
          <span class="who">给谁用：30–300 人的五金冲压、塑胶射出、电子组装厂；主要使用者是品质主管、质检组长和检验员</span>

          <div class="steps">
            <div class="step"><b>第 1 步</b><span>选一套检查项模板，填工单 / 批号 / 机台 / 检验员</span></div>
            <div class="step"><b>第 2 步</b><span>逐项量测输入，超上限下限自动标红并写清哪里不合格</span></div>
            <div class="step"><b>第 3 步</b><span>不合格自动开异常单；之后按批号追溯、出日报周报</span></div>
          </div>

          <div class="hero-actions">
            <el-button type="primary" size="large" :loading="demoBusy" @click="runDemo">用示例工单试一次</el-button>
            <el-button size="large" @click="startNewInspection">开始一笔新检验</el-button>
            <el-button v-if="records.length && records.some(r => r.demo)" size="large" text @click="clearDemoData">清除示例数据</el-button>
          </div>
          <p style="margin:12px 0 0;font-size:13.5px;color:rgba(255,255,255,0.85)">
            「用示例工单试一次」会建立 1 笔现场检验 + 6 天示例台账，全部标了「示例」，可一键清除。示例检查项：{{ demoSample }}
          </p>
        </section>

        <div class="grid c3">
          <div class="stat">
            <div class="k">本机已有的检验记录</div>
            <div class="v">{{ records.length }} 笔</div>
          </div>
          <div class="stat" :class="openAnomalies.length ? 'bad' : 'good'">
            <div class="k">未关闭异常单</div>
            <div class="v">{{ openAnomalies.length }} 张</div>
          </div>
          <div class="stat">
            <div class="k">近 7 天批次不良率</div>
            <div class="v">{{ pctText(weekReport.defectBatchRate) }}</div>
            <div class="k">{{ weekReport.batches }} 批 / {{ weekReport.failBatches }} 批不合格</div>
          </div>
          <div class="stat">
            <div class="k">照片留证</div>
            <div class="v small">{{ photos.length }} 张（{{ formatBytes(photosBytes) }}）</div>
          </div>
        </div>

        <div v-if="!records.length" class="card">
          <h2>还没有任何记录</h2>
          <p class="hint">
            第一次用，建议先点上面的「用示例工单试一次」，看清楚整条链路；也可以直接从「现场检验」开始录第一笔。
            三套内置检查项模板（五金冲压 / 塑胶射出 / 电子组装）已经装好了，随时可改。
          </p>
          <el-button type="primary" @click="startNewInspection">直接开始第一笔</el-button>
        </div>

        <div v-else class="card">
          <div class="spread">
            <h2>最近这一周</h2>
            <el-button @click="go('report')">看完整报表</el-button>
          </div>
          <p class="hint">
            {{ weekReport.batches }} 批检验、{{ weekReport.checkedItems }} 项次，项次不良率 {{ pctText(weekReport.defectItemRate) }}，
            未关闭异常 {{ weekReport.openCount }} 张。
          </p>
          <div class="hbar" v-for="d in weekReport.topDefects" :key="d.name">
            <span>{{ d.name }}</span>
            <span class="track"><span class="fill" :style="{ width: (d.count / topMax * 100) + '%' }"></span></span>
            <span class="num">{{ d.count }} 次</span>
          </div>
          <p v-if="!weekReport.topDefects.length" class="hint">近 7 天没有不合格项 —— 好事。</p>
        </div>
      </template>

      <!-- ==================================================================
           现场检验
           ================================================================== -->
      <template v-if="view === 'inspect'">
        <div v-if="!templates.length" class="card">
          <h2>还没有检查项模板</h2>
          <p class="hint">检查项模板决定「要检哪些项目、上下限多少」。可以新建一套，或导入同事给的模板 JSON。</p>
          <el-button type="primary" @click="go('template')">去建检查项模板</el-button>
        </div>

        <template v-else>
          <div v-if="lastSaved" class="card" :class="lastSaved.record.verdict === 'fail' ? 'banner fail' : 'banner ok'" style="display:block">
            <div class="spread">
              <div>
                <div class="bt" style="font-size:18px">
                  {{ lastSaved.record.verdict === 'fail' ? '不合格，已开异常单' : '已存档，本批合格' }}
                  <span v-if="lastSaved.levelLabel">（{{ lastSaved.levelLabel }}）</span>
                </div>
                <div class="bd">
                  {{ lastSaved.summary.when }}，{{ lastSaved.summary.templateName }}，{{ lastSaved.summary.machine }}，检验员 {{ lastSaved.summary.inspector }}
                  <span v-if="lastSaved.summary.failedCount"> · 不合格项：{{ lastSaved.summary.failedNames.join('、') }}</span>
                </div>
              </div>
              <div class="row">
                <el-button v-if="lastSaved.anomaly" @click="go('anomaly')">去处理异常单</el-button>
                <el-button type="primary" @click="nextInspection">继续下一笔</el-button>
              </div>
            </div>
          </div>

          <section class="card">
            <h2>这一笔：先选模板，再填工单</h2>
            <p class="hint">模板可以在「检查项模板」页改。工单、机台、检验员会记住上次填的，下一笔不用重打。</p>
            <div class="row" style="margin-bottom:14px">
              <span class="pick-label">检查项模板</span>
              <div class="pickgroup">
                <button
                  v-for="t in templates"
                  :key="t.id"
                  type="button"
                  class="pick"
                  :class="{ active: inspect.templateId === t.id }"
                  @click="pickTemplate(t.id)"
                >
                  {{ t.name }}
                </button>
              </div>
            </div>
            <div class="inspect-head">
              <label>
                <span class="hint" style="margin:0">工单号 *</span>
                <input class="text-input" list="qc-wo-list" v-model="inspect.workOrder" placeholder="例：MO-261018-01" aria-label="工单号" />
                <datalist id="qc-wo-list">
                  <option v-for="w in workOrders" :key="w" :value="w"></option>
                </datalist>
              </label>
              <label>
                <span class="hint" style="margin:0">批号 *</span>
                <input class="text-input" list="qc-batch-list" v-model="inspect.batchNo" placeholder="例：B-261018-01" aria-label="批号" />
                <datalist id="qc-batch-list">
                  <option v-for="b in batches" :key="b" :value="b"></option>
                </datalist>
              </label>
              <label>
                <span class="hint" style="margin:0">机台 *</span>
                <input class="text-input" list="qc-machine-list" v-model="inspect.machine" placeholder="例：冲床 #3" aria-label="机台" />
                <datalist id="qc-machine-list">
                  <option v-for="m in machines" :key="m" :value="m"></option>
                </datalist>
              </label>
              <label>
                <span class="hint" style="margin:0">检验员 *</span>
                <input class="text-input" list="qc-inspector-list" v-model="inspect.inspector" placeholder="谁检的（要追责到人）" aria-label="检验员" />
                <datalist id="qc-inspector-list">
                  <option v-for="p in inspectors" :key="p" :value="p"></option>
                </datalist>
              </label>
              <div>
                <span class="hint" style="margin:0">班别</span>
                <div class="pickgroup">
                  <button
                    v-for="s in SHIFTS"
                    :key="s"
                    type="button"
                    class="pick"
                    :class="{ active: inspect.shift === s }"
                    @click="inspect.shift = s"
                  >
                    {{ s }}
                  </button>
                </div>
              </div>
              <label>
                <span class="hint" style="margin:0">批量（件）</span>
                <input class="big-input" inputmode="numeric" v-model="inspect.qty" placeholder="900" aria-label="批量" />
              </label>
            </div>
          </section>

          <section class="card">
            <div class="spread">
              <h2>逐项检验（{{ activeTemplate ? activeTemplate.items.length : 0 }} 项）</h2>
              <span class="hint" style="margin:0">
                {{ progress.filled }} / {{ progress.required }} 必填项已填
                <el-tag v-if="judged.failed.length" type="danger" effect="dark" style="margin-left:8px">
                  {{ judged.failed.length }} 项不合格
                </el-tag>
              </span>
            </div>
            <p class="hint">数字键盘已打开；按回车跳到下一项。超限会整行变红并写明为什么。</p>

            <div v-for="it in activeTemplate.items" :key="it.id" class="item" :class="itemClass(it)">
              <div>
                <div class="iname">{{ it.name }}</div>
                <div class="ispec">{{ specText(it) }}</div>
                <div class="imeta">
                  <span class="tag" :class="severityTagClass(it)">{{ severityLabel(it) }}</span>
                  <span v-if="it.frequency" class="tag">{{ it.frequency }}</span>
                  <span v-if="it.required !== false" class="tag req">必填</span>
                </div>
                <div v-if="it.hint" class="hint" style="margin:6px 0 0">{{ it.hint }}</div>
              </div>

              <div class="ifield">
                <template v-if="it.type === 'number'">
                  <el-button @click="bump(it, -1)" :aria-label="'减小 ' + it.name">−</el-button>
                  <input
                    class="big-input"
                    data-field="1"
                    inputmode="decimal"
                    v-model="values[it.id]"
                    :aria-label="it.name"
                    :placeholder="String(nominalValue(it))"
                    @keydown.enter.prevent="focusNext"
                    style="max-width:150px"
                  />
                  <span class="unit">{{ it.unit }}</span>
                  <el-button @click="bump(it, 1)" :aria-label="'增大 ' + it.name">+</el-button>
                  <el-button text @click="fillNominal(it)">标准值</el-button>
                </template>

                <template v-else-if="it.type === 'bool'">
                  <div class="pickgroup">
                    <button
                      type="button"
                      class="pick big"
                      :class="{ active: values[it.id] === true }"
                      :aria-pressed="values[it.id] === true"
                      @click="values[it.id] = true"
                    >是</button>
                    <button
                      type="button"
                      class="pick big"
                      :class="{ active: values[it.id] === false }"
                      :aria-pressed="values[it.id] === false"
                      @click="values[it.id] = false"
                    >否</button>
                  </div>
                </template>

                <template v-else-if="it.type === 'option'">
                  <div class="pickgroup">
                    <button
                      v-for="o in (it.options && it.options.length ? it.options : it.okOptions)"
                      :key="o"
                      type="button"
                      class="pick"
                      :class="{ active: values[it.id] === o }"
                      :aria-pressed="values[it.id] === o"
                      @click="values[it.id] = o"
                    >{{ o }}</button>
                  </div>
                </template>

                <template v-else>
                  <el-input v-model="values[it.id]" type="textarea" :rows="2" :placeholder="it.hint || '看到什么写什么'" />
                </template>

                <span class="judge" :class="resultOf(it.id).status">{{ resultOf(it.id).label }}</span>
              </div>

              <div style="grid-column:1/-1">
                <span v-if="resultOf(it.id).status === 'fail'" style="color:var(--fail);font-weight:700">
                  ✕ {{ resultOf(it.id).reason }}
                </span>
                <span v-else-if="resultOf(it.id).status === 'invalid'" style="color:var(--warn);font-weight:700">
                  ! {{ resultOf(it.id).reason }}
                </span>
                <span v-else-if="resultOf(it.id).status === 'pass'" style="color:var(--ink-2)">✓ {{ resultOf(it.id).reason }}</span>
              </div>
            </div>
          </section>

          <section class="card">
            <h2>备注与照片</h2>
            <p class="hint">照片在本机压缩（最长边 1280、JPEG）后只存在这台设备上，不会上传到任何地方。</p>
            <el-input v-model="inspect.note" type="textarea" :rows="2" placeholder="例：换料后首件，重量偏上限，已通知调机" />

            <div class="row" style="margin-top:12px">
              <el-button :loading="photoBusy" @click="$refs.photoInput.click()">拍照 / 选照片</el-button>
              <input ref="photoInput" type="file" accept="image/*" multiple capture="environment" class="visually-hidden" @change="onPickPhotos" />
              <span class="hint" style="margin:0">也可以把照片直接拖到下面这块区域</span>
            </div>

            <div
              v-if="!pendingPhotos.length"
              style="margin-top:10px;padding:18px;border:2px dashed var(--line-strong);border-radius:12px;text-align:center;color:var(--ink-2)"
              @dragover.prevent
              @drop.prevent="onDropPhotos"
            >
              把不良品 / 不良位置的照片拖进来（没有照片也能存档）
            </div>
            <div v-else class="thumbs" style="margin-top:12px" @dragover.prevent @drop.prevent="onDropPhotos">
              <div v-for="p in pendingPhotos" :key="p.id" class="thumb">
                <img :src="p.url" :alt="p.name" />
                <button class="del" @click="removePendingPhoto(p.id)" :aria-label="'删除 ' + p.name">✕</button>
                <span class="cap">{{ Math.round(p.size / 1024) }} KB</span>
              </div>
            </div>

            <div class="sticky-actions">
              <span>
                <b>{{ progress.filled }} / {{ progress.required }}</b> 必填项
                <span v-if="headerMissing.length" style="color:var(--fail);margin-left:10px">还差：{{ headerMissing.join('、') }}</span>
                <span v-else-if="judged.verdict === 'fail'" style="color:var(--fail);margin-left:10px">本批不合格，保存后会开异常单</span>
              </span>
              <span class="row">
                <el-button @click="clearValues">清空数值</el-button>
                <el-button type="primary" size="large" :disabled="!canSave" :loading="saving" @click="saveInspection()">保存这一笔</el-button>
              </span>
            </div>
          </section>
        </template>
      </template>

      <!-- ==================================================================
           异常处理
           ================================================================== -->
      <template v-if="view === 'anomaly'">
        <section class="card">
          <div class="spread">
            <h2>异常单</h2>
            <div class="pickgroup">
              <button type="button" class="pick" :class="{ active: anomalyFilter === 'open' }" @click="anomalyFilter = 'open'">未关闭（{{ openAnomalies.length }}）</button>
              <button type="button" class="pick" :class="{ active: anomalyFilter === 'closed' }" @click="anomalyFilter = 'closed'">已关闭</button>
              <button type="button" class="pick" :class="{ active: anomalyFilter === 'all' }" @click="anomalyFilter = 'all'">全部（{{ anomalies.length }}）</button>
            </div>
          </div>
          <p class="hint">
            分级规则：关键项不合格 → 报废；主要项不合格 → 隔离（偏离规格带 50% 以上转报废）；只剩次要项 → 返工。
            「让步接收」必须由品质主管核准，系统不会替你选。
          </p>

          <div v-if="!visibleAnomalies.length" style="padding:16px;text-align:center;color:var(--ink-2)">
            没有符合条件的异常单 —— 未关闭的是 {{ openAnomalies.length }} 张。
          </div>
          <div v-for="a in visibleAnomalies" :key="a.id" class="card" style="box-shadow:none;margin-bottom:10px" :style="{ borderLeft: '6px solid ' + LEVEL_COLOR[a.level] }">
            <div class="spread">
              <div>
                <div style="font-size:17px;font-weight:700">
                  <span class="tag" :style="{ background: LEVEL_COLOR[a.level], color: '#fff', borderColor: LEVEL_COLOR[a.level] }">{{ LEVEL_MAP[a.level].label }}</span>
                  {{ a.batchNo || '（无批号）' }} · {{ a.machine || '（无机台）' }}
                  <span v-if="a.closed" class="tag minor" style="margin-left:6px">已关闭</span>
                  <span v-else-if="isOverdue(a)" class="tag crit" style="margin-left:6px">超过 24 小时没关</span>
                </div>
                <div class="hint" style="margin:6px 0 0">
                  {{ formatDateTime(a.createdAt) }} 开单，检验员 {{ a.inspector || '—' }}，
                  处置人 {{ a.handler || '（未指派）' }}，已挂 {{ hoursOpen(a) }} 小时
                </div>
                <div style="margin-top:6px">
                  <span v-for="f in a.failedItems" :key="f.name" class="tag crit" style="margin-right:6px">
                    {{ f.name }} = {{ f.value }}{{ f.unit }}（{{ f.limit }}）
                  </span>
                </div>
                <p class="hint" style="margin:8px 0 0">原因：{{ a.reason }}</p>
                <p v-if="a.closed" class="hint" style="margin:4px 0 0">
                  处理结果：{{ a.closureNote }}（{{ formatDateTime(a.closedAt) }}）
                </p>
                <div v-if="anomPhotos[a.id] && anomPhotos[a.id].length" class="thumbs" style="margin-top:10px">
                  <div v-for="p in anomPhotos[a.id]" :key="p.id" class="thumb">
                    <img :src="photoSrc(p)" :alt="p.name" />
                  </div>
                </div>
              </div>
              <div class="row" style="align-self:flex-start">
                <el-button @click="assignHandler(a)">{{ a.handler ? '改处置人' : '指派处置人' }}</el-button>
                <el-button v-if="!a.closed" type="primary" @click="askClose(a)">标记已关闭</el-button>
              </div>
            </div>
          </div>
        </section>

        <section v-if="orphanFails.length" class="card">
          <h2>不合格但没开异常单的记录（{{ orphanFails.length }} 笔）</h2>
          <p class="hint">
            现场保存时会自动跳出来开单，但如果当时点了「先不开单」，这里就会留着。
            品质主管可以直接补开，账就平了。
          </p>
          <div v-for="r in orphanFails" :key="r.id" class="spread" style="padding:8px 0;border-bottom:1px solid var(--line)">
            <span>
              {{ formatDateTime(r.createdAt) }} · {{ r.batchNo }} · {{ r.machine }} · {{ r.inspector }} ·
              <b style="color:var(--fail)">{{ r.results.filter(x => x.status === 'fail').map(x => x.name).join('、') }}</b>
            </span>
            <el-button type="primary" plain @click="openAnomalyFor(r)">补开异常单</el-button>
          </div>
        </section>

        <section class="card">
          <h2>客户投诉 → 该查哪一项</h2>
          <p class="hint">
            把客户的原话粘进来，自动贴到对应的检查项上，再去「追溯查询」按这一项搜，就能捞出是哪一批、谁检的。
            默认用离线规则（本机关键词匹配，不联网）；如果你自己贴了 AI Key，也可以让它来判。
          </p>
          <el-input v-model="aiText" type="textarea" :rows="2" placeholder="例：客户反馈这批卡扣间距偏大，装不进外壳，还有几件外壳有刮伤" />
          <div class="row" style="margin-top:10px">
            <el-button @click="classifyByRule">用离线规则归类</el-button>
            <el-button :loading="aiBusy" @click="classifyByAi">用 AI 归类（需自备 Key）</el-button>
          </div>
          <div v-if="aiError" class="hint" style="color:var(--warn)">{{ aiError }}</div>
          <div v-if="aiResult" class="card" style="box-shadow:none;margin-top:12px">
            <div class="bt">
              归类方式：{{ aiResult.mode === 'ai' ? 'AI（自备 Key）' : '离线规则' }}
              <span v-if="aiResult.confidence"> · 把握度 {{ Math.round(aiResult.confidence * 100) }}%</span>
            </div>
            <div v-if="aiResult.matches.length" class="row" style="margin-top:8px">
              <el-tag v-for="m in aiResult.matches" :key="m.name" type="danger" effect="light">{{ m.name }}</el-tag>
              <el-button size="small" @click="traceFilter.keyword = aiResult.matches[0].name; go('trace')">按这一项去追溯</el-button>
            </div>
            <p v-else class="hint" style="margin:8px 0 0">没能对上任何检查项。可以手动去追溯里搜关键词，或把这项加进模板。</p>
            <p v-if="aiResult.note" class="hint" style="margin:6px 0 0">{{ aiResult.note }}</p>
          </div>
        </section>

        <el-dialog v-model="closeDialog.open" title="关闭异常单" width="520px">
          <p class="hint">关闭要写清怎么处理的 —— 半年后有人问起，这行字就是答案。</p>
          <el-input v-model="closeDialog.closureNote" type="textarea" :rows="3" placeholder="例：调机后重新试模，熔接痕已消除；同批 1100 件全检后放行。" />
          <div style="margin-top:10px">
            <span class="hint" style="margin:0">处置人</span>
            <el-input v-model="closeDialog.handler" placeholder="谁处理的" />
          </div>
          <template #footer>
            <el-button @click="closeDialog.open = false">取消</el-button>
            <el-button type="primary" @click="doClose">确认关闭</el-button>
          </template>
        </el-dialog>
      </template>

      <!-- ==================================================================
           追溯查询
           ================================================================== -->
      <template v-if="view === 'trace'">
        <section class="card">
          <h2>出事了就从这里翻</h2>
          <p class="hint">填任一条件即可查询。只知道不良现象？直接填在「关键字」里（会搜不合格项、实测值、备注和异常单的处理经过）。</p>
          <div class="inspect-head">
            <label>
              <span class="hint" style="margin:0">批号</span>
              <el-input v-model="traceFilter.batchNo" placeholder="B-261018-01" />
            </label>
            <label>
              <span class="hint" style="margin:0">工单</span>
              <el-input v-model="traceFilter.workOrder" placeholder="MO-261018" />
            </label>
            <label>
              <span class="hint" style="margin:0">机台</span>
              <select class="text-input" v-model="traceFilter.machine" aria-label="机台">
                <option value="">全部</option>
                <option v-for="m in machines" :key="m" :value="m">{{ m }}</option>
              </select>
            </label>
            <label>
              <span class="hint" style="margin:0">检验员</span>
              <select class="text-input" v-model="traceFilter.inspector" aria-label="检验员">
                <option value="">全部</option>
                <option v-for="p in inspectors" :key="p" :value="p">{{ p }}</option>
              </select>
            </label>
            <label>
              <span class="hint" style="margin:0">起始日期</span>
              <input type="date" v-model="dateFrom" class="date-input" aria-label="起始日期" />
            </label>
            <label>
              <span class="hint" style="margin:0">截止日期</span>
              <input type="date" v-model="dateTo" class="date-input" aria-label="截止日期" />
            </label>
            <label>
              <span class="hint" style="margin:0">结论</span>
              <select class="text-input" v-model="traceFilter.verdict" aria-label="结论">
                <option value="all">全部</option>
                <option value="fail">不合格</option>
                <option value="pass">合格</option>
                <option value="incomplete">未完成</option>
              </select>
            </label>
            <label>
              <span class="hint" style="margin:0">异常等级</span>
              <select class="text-input" v-model="traceFilter.level" aria-label="异常等级">
                <option value="all">全部</option>
                <option v-for="l in LEVELS" :key="l.value" :value="l.value">{{ l.label }}</option>
              </select>
            </label>
            <label>
              <span class="hint" style="margin:0">关键字</span>
              <el-input v-model="traceFilter.keyword" placeholder="不良现象 / 实测值 / 处置人" />
            </label>
          </div>
          <div class="row" style="margin-top:12px">
            <button type="button" class="pick" @click="lastWeek">近 7 天</button>
            <el-button @click="resetTrace">重置条件</el-button>
            <el-button type="primary" @click="exportTraceCsv">导出 CSV（一行一笔）</el-button>
            <el-button @click="exportTraceLongCsv">导出 CSV（一行一项）</el-button>
            <el-button @click="exportAnomalyCsv">导出异常单 CSV</el-button>
          </div>
        </section>

        <section class="card">
          <div class="spread">
            <h2>查到 {{ traceResults.length }} 笔</h2>
            <span class="hint" style="margin:0">点任意一行看当时的完整记录与照片</span>
          </div>
          <div v-if="!traceResults.length" style="padding:16px;text-align:center;color:var(--ink-2)">
            没有符合条件的记录。试试只填一个条件，或者把时间放长一点。
          </div>
          <el-table v-else :data="traceRows" size="default" border @row-click="row => openDetail(traceResults.find(r => r.id === row.id))">
            <el-table-column prop="when" label="时间" width="138" />
            <el-table-column prop="batchNo" label="批号" width="132" />
            <el-table-column prop="workOrder" label="工单" width="132" />
            <el-table-column prop="machine" label="机台" width="110" />
            <el-table-column prop="inspector" label="检验员" width="96" />
            <el-table-column prop="templateName" label="模板" min-width="150" show-overflow-tooltip />
            <el-table-column label="结论" width="96">
              <template #default="{ row }">
                <el-tag :type="row.verdict === 'fail' ? 'danger' : row.verdict === 'pass' ? 'success' : 'warning'" effect="dark" size="small">
                  {{ row.verdictLabel }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="异常" width="96">
              <template #default="{ row }">
                <span v-if="row.anomalyLevelLabel" class="tag crit">{{ row.anomalyLevelLabel }}</span>
                <span v-else>—</span>
              </template>
            </el-table-column>
            <el-table-column label="照片" width="70">
              <template #default="{ row }">{{ row.photoCount || '—' }}</template>
            </el-table-column>
          </el-table>
        </section>

        <el-drawer v-model="detailOpen" size="min(620px, 96vw)" :with-header="false">
          <div v-if="detail">
            <div class="spread">
              <h2>{{ detail.batchNo }}</h2>
              <el-button @click="closeDetail">关闭</el-button>
            </div>
            <p class="hint">
              {{ formatDateTime(detail.createdAt) }}，工单 {{ detail.workOrder }}，{{ detail.machine }}，
              检验员 <b>{{ detail.inspector }}</b>，{{ detail.shift }}，批量 {{ detail.qty || '—' }} 件
            </p>
            <p class="hint">
              结论：
              <el-tag :type="detail.verdict === 'fail' ? 'danger' : 'success'" effect="dark" size="small">
                {{ detail.verdict === 'fail' ? '不合格' : detail.verdict === 'pass' ? '合格' : '未完成' }}
              </el-tag>
              <span v-if="detail.anomalyId"> · 异常单 {{ detail.anomalyId }}（{{ LEVEL_MAP[detail.anomalyLevel].label }}）</span>
            </p>
            <p v-if="detail.note" class="hint">备注：{{ detail.note }}</p>

            <el-table :data="detail.results" size="small" border>
              <el-table-column prop="name" label="检查项" min-width="110" />
              <el-table-column prop="limit" label="规格" min-width="120" />
              <el-table-column label="实测" width="90">
                <template #default="{ row }">{{ valueText(row) }}</template>
              </el-table-column>
              <el-table-column label="判定" width="86">
                <template #default="{ row }">
                  <el-tag :type="row.status === 'fail' ? 'danger' : row.status === 'pass' ? 'success' : 'info'" size="small" :effect="row.status === 'fail' ? 'dark' : 'light'">
                    {{ row.status === 'fail' ? '不合格' : row.status === 'pass' ? '合格' : row.label }}
                  </el-tag>
                </template>
              </el-table-column>
            </el-table>

            <h3 style="margin:16px 0 8px">留证照片（{{ (photosByRecord[detail.id] || []).length }} 张）</h3>
            <div v-if="(photosByRecord[detail.id] || []).length" class="thumbs">
              <div v-for="p in photosByRecord[detail.id]" :key="p.id" class="thumb">
                <img :src="photoSrc(p)" :alt="p.name" />
                <button class="del" @click="removePhoto(p.id)" aria-label="删除照片">✕</button>
              </div>
            </div>
            <p v-else class="hint">这一笔没有照片。</p>
          </div>
        </el-drawer>
      </template>

      <!-- ==================================================================
           报表
           ================================================================== -->
      <template v-if="view === 'report'">
        <section class="card">
          <div class="spread no-print">
            <h2>质检报表</h2>
            <div class="row">
              <div class="pickgroup">
                <button type="button" class="pick" :class="{ active: granularity === 'day' }" @click="setGranularity('day')">日报</button>
                <button type="button" class="pick" :class="{ active: granularity === 'week' }" @click="setGranularity('week')">周报</button>
                <button type="button" class="pick" :class="{ active: granularity === 'month' }" @click="setGranularity('month')">月报</button>
              </div>
              <el-button @click="exportReportMd">导出 Markdown</el-button>
              <el-button type="primary" @click="printReport">打印 / 存 PDF</el-button>
            </div>
          </div>
          <h2 class="print-title">{{ report.label }}</h2>
          <p class="hint">
            {{ report.label }}：{{ formatDateTime(report.from) }} ～ {{ formatDateTime(report.to) }}
            （生成于 {{ formatDateTime(report.generatedAt) }}，数据全部来自本机）
          </p>

          <div class="grid c3">
            <div class="stat">
              <div class="k">检验批次</div>
              <div class="v">{{ report.batches }}</div>
              <div class="k">上一区间 {{ report.prevBatches }} 批</div>
            </div>
            <div class="stat" :class="report.failBatches ? 'bad' : 'good'">
              <div class="k">批次不良率</div>
              <div class="v">{{ pctText(report.defectBatchRate) }}</div>
              <div class="k">{{ report.failBatches }} 批不合格 / 上一区间 {{ pctText(report.prevDefectBatchRate) }}</div>
            </div>
            <div class="stat">
              <div class="k">项次不良率</div>
              <div class="v">{{ pctText(report.defectItemRate) }}</div>
              <div class="k">{{ report.failedItems }} 项次不合格 / 共 {{ report.checkedItems }} 项次</div>
            </div>
            <div class="stat" :class="report.openCount ? 'bad' : 'good'">
              <div class="k">未关闭异常</div>
              <div class="v">{{ report.openCount }}</div>
              <div class="k">
                <span v-if="report.avgCloseHours !== null">平均关闭时长 {{ report.avgCloseHours }} 小时</span>
                <span v-else>本区间没有关闭过异常</span>
              </div>
            </div>
          </div>
        </section>

        <section class="card">
          <h2>每日批次与不合格批次</h2>
          <p class="hint">深灰柱＝当天检验批次，红段＝其中的不合格批次。</p>
          <svg class="chart" :viewBox="'0 0 ' + barChart.W + ' ' + barChart.H" role="img" aria-label="每日检验批次柱状图">
            <g>
              <line v-for="t in barChart.ticks" :key="'grid' + t.v" class="grid" :x1="barChart.x0" :x2="barChart.x1" :y1="t.y" :y2="t.y" />
              <text v-for="t in barChart.ticks" :key="'yt' + t.v" class="ylabel" :x="barChart.x0 - 6" :y="t.y + 4" text-anchor="end">{{ t.v }}</text>
              <line class="axis" :x1="barChart.x0" :x2="barChart.x1" :y1="barChart.baseline" :y2="barChart.baseline" />
              <g v-for="b in barChart.bars" :key="b.key">
                <rect class="bar-ok" :x="b.x" :y="b.y" :width="b.w" :height="Math.max(0, b.h)" rx="3" />
                <rect class="bar-fail" :x="b.x" :y="b.fy" :width="b.w" :height="Math.max(0, b.fh)" rx="3" />
                <text class="bar-val" :x="b.cx" :y="b.ty">{{ b.batches || '' }}</text>
                <text class="bar-lab" :x="b.cx" :y="b.ly">{{ b.label }}</text>
              </g>
            </g>
          </svg>
          <p v-if="!report.batches" class="hint">这个区间还没有检验记录 —— 换个区间，或者去「现场检验」录一笔。</p>
        </section>

        <div class="grid c2">
          <section class="card">
            <h2>Top 不良项</h2>
            <p class="hint">按不合格项次排序 —— 前两项通常就是该去调机的地方。</p>
            <div v-for="d in report.topDefects" :key="d.name" class="hbar">
              <span>{{ d.name }}</span>
              <span class="track"><span class="fill" :style="{ width: (d.count / topMax * 100) + '%' }"></span></span>
              <span class="num">{{ d.count }} 次</span>
            </div>
            <p v-if="!report.topDefects.length" class="hint">本区间没有不合格项。</p>
          </section>

          <section class="card">
            <h2>异常分级分布</h2>
            <p class="hint">决定「要不要停线、要不要报废」的依据。</p>
            <div v-if="levelSegs.length">
              <div class="segbar">
                <i v-for="s in levelSegs" :key="s.key" :style="{ width: s.pct + '%', background: s.color }" :title="s.label"></i>
              </div>
              <div class="legend">
                <span v-for="s in levelSegs" :key="s.key"><i :style="{ background: s.color }"></i>{{ s.label }} {{ s.count }} 张</span>
              </div>
            </div>
            <p v-else class="hint">本区间没有开异常单。</p>

            <h3 style="margin:18px 0 8px">按检验员</h3>
            <el-table :data="report.inspectors" size="small" border>
              <el-table-column prop="name" label="检验员" />
              <el-table-column prop="batches" label="批次" width="70" />
              <el-table-column prop="fail" label="不合格" width="76" />
              <el-table-column prop="photos" label="照片" width="66" />
            </el-table>
            <p v-if="!report.inspectors.length" class="hint">本区间没有检验记录。</p>
          </section>
        </div>

        <section class="card">
          <h2>未关闭异常单清单</h2>
          <p class="hint no-print">这份清单是要拿去催人的：按开单时间排，超过 24 小时的会标红。</p>
          <div v-if="!report.openAnomalies.length" class="hint">没有未关闭的异常单。</div>
          <el-table v-else :data="report.openAnomalies" size="small" border>
            <el-table-column label="开单时间" width="138">
              <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
            </el-table-column>
            <el-table-column label="等级" width="92">
              <template #default="{ row }">
                <span class="tag" :style="{ background: LEVEL_COLOR[row.level], color: '#fff', borderColor: LEVEL_COLOR[row.level] }">{{ LEVEL_MAP[row.level].label }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="batchNo" label="批号" width="132" />
            <el-table-column prop="machine" label="机台" width="110" />
            <el-table-column label="不良项" min-width="130">
              <template #default="{ row }">{{ row.failedItems.map(f => f.name).join('、') }}</template>
            </el-table-column>
            <el-table-column label="处置人" width="110">
              <template #default="{ row }">
                <span v-if="row.handler">{{ row.handler }}</span>
                <span v-else style="color:var(--fail)">（未指派）</span>
              </template>
            </el-table-column>
            <el-table-column label="已挂时长" width="100">
              <template #default="{ row }">{{ hoursOpen(row) }} h</template>
            </el-table-column>
          </el-table>
        </section>
      </template>

      <!-- ==================================================================
           检查项模板
           ================================================================== -->
      <template v-if="view === 'template'">
        <section class="card">
          <h2>检查项模板</h2>
          <p class="hint">
            检查项就是「这一批要量什么」。已录好的记录会保存当时的规格，所以现在改模板不会影响历史数据。
            内置三套示例（五金冲压 / 塑胶射出 / 电子组装）可以直接改，改完存成自己的。
          </p>
          <div class="row">
            <el-button v-for="t in templates" :key="t.id" :type="activeTemplate && activeTemplate.id === t.id ? 'primary' : 'default'" @click="pickTemplate(t.id); startEditTemplate(t)">
              {{ t.name }}（{{ t.items.length }} 项）
            </el-button>
          </div>
          <div class="row" style="margin-top:12px">
            <el-button @click="newTemplate">基于当前模板做副本</el-button>
            <el-button @click="blankTemplate">新建空白模板</el-button>
            <el-button @click="$refs.tplInput.click()">导入模板 JSON</el-button>
            <input ref="tplInput" type="file" accept="application/json,.json" class="visually-hidden" @change="onImportTemplate" />
            <el-button v-if="activeTemplate" @click="exportTemplate">导出当前模板</el-button>
          </div>
        </section>

        <section v-if="editing" class="card">
          <div class="spread">
            <h2>正在编辑：{{ editing.name }}</h2>
            <div class="row">
              <el-button @click="editing = null">放弃修改</el-button>
              <el-button type="primary" @click="saveTemplate">保存模板</el-button>
              <el-button type="danger" plain @click="removeTemplate(editing)">删除这套模板</el-button>
            </div>
          </div>
          <div class="inspect-head">
            <label>
              <span class="hint" style="margin:0">模板名称</span>
              <el-input v-model="editing.name" />
            </label>
            <label>
              <span class="hint" style="margin:0">适合什么产品</span>
              <el-input v-model="editing.industry" placeholder="例：五金 / 冲压" />
            </label>
            <label>
              <span class="hint" style="margin:0">说明</span>
              <el-input v-model="editing.note" placeholder="例：25–200 吨冲床，首件 + 每 2 小时巡检" />
            </label>
          </div>

          <el-table :data="editing.items" size="small" border style="margin-top:14px">
            <el-table-column type="index" width="46" />
            <el-table-column prop="name" label="检查项" min-width="120" />
            <el-table-column label="类型" width="110">
              <template #default="{ row }">{{ (ITEM_TYPES.find(x => x.value === row.type) || {}).label }}</template>
            </el-table-column>
            <el-table-column label="规格" min-width="140">
              <template #default="{ row }">{{ specText(row) }}</template>
            </el-table-column>
            <el-table-column label="严重度" width="90">
              <template #default="{ row }">
                <span class="tag" :class="defaultSeverity(row) === 'critical' ? 'crit' : defaultSeverity(row) === 'major' ? 'major' : 'minor'">
                  {{ defaultSeverity(row) === 'critical' ? '关键' : defaultSeverity(row) === 'major' ? '主要' : '次要' }}
                </span>
              </template>
            </el-table-column>
            <el-table-column prop="frequency" label="抽样频率" width="104" />
            <el-table-column label="必填" width="66">
              <template #default="{ row }">{{ row.required === false ? '否' : '是' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="200">
              <template #default="{ row, $index }">
                <el-button size="small" @click="editItem($index)">编辑</el-button>
                <el-button size="small" @click="moveItem($index, -1)">上移</el-button>
                <el-button size="small" type="danger" text @click="removeItem($index)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div class="row" style="margin-top:12px">
            <el-button type="primary" plain @click="addItem">+ 加一个检查项</el-button>
            <span class="hint" style="margin:0">
              共 {{ editing.items.length }} 项，其中关键项 {{ editing.items.filter(i => defaultSeverity(i) === 'critical').length }} 个
            </span>
          </div>
        </section>

        <section v-else class="card">
          <p class="hint">从上面选一套模板开始改，或新建一套。</p>
        </section>

        <el-dialog v-model="itemDialog.open" :title="itemDialog.index >= 0 ? '编辑检查项' : '新增检查项'" width="620px">
          <div class="inspect-head">
            <label>
              <span class="hint" style="margin:0">名称 *</span>
              <el-input v-model="itemDialog.draft.name" placeholder="例：外径" />
            </label>
            <label>
              <span class="hint" style="margin:0">类型</span>
              <select class="text-input" v-model="itemDialog.draft.type" aria-label="检查项类型">
                <option v-for="t in ITEM_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
              </select>
            </label>
            <label>
              <span class="hint" style="margin:0">单位</span>
              <el-input v-model="itemDialog.draft.unit" placeholder="mm / g / °C" />
            </label>
            <label>
              <span class="hint" style="margin:0">严重度（决定异常分级）</span>
              <select class="text-input" v-model="itemDialog.draft.severity" aria-label="严重度">
                <option v-for="s in SEVERITIES" :key="s.value" :value="s.value">{{ s.label }}</option>
              </select>
            </label>
            <label>
              <span class="hint" style="margin:0">抽样频率</span>
              <input class="text-input" list="qc-freq-list" v-model="itemDialog.draft.frequency" aria-label="抽样频率" placeholder="每 2 小时" />
              <datalist id="qc-freq-list">
                <option v-for="f in FREQUENCIES" :key="f" :value="f"></option>
              </datalist>
            </label>
            <label>
              <span class="hint" style="margin:0">是否必填</span>
              <div class="pickgroup">
                <button type="button" class="pick" :class="{ active: itemDialog.draft.required === true }" @click="itemDialog.draft.required = true">必填</button>
                <button type="button" class="pick" :class="{ active: itemDialog.draft.required === false }" @click="itemDialog.draft.required = false">可留空</button>
              </div>
            </label>
          </div>

          <template v-if="itemDialog.draft.type === 'number'">
            <div class="inspect-head" style="margin-top:12px">
              <label>
                <span class="hint" style="margin:0">下限（可留空）</span>
                <el-input v-model="itemDialog.draft.min" inputmode="decimal" placeholder="9.8" />
              </label>
              <label>
                <span class="hint" style="margin:0">上限（可留空）</span>
                <el-input v-model="itemDialog.draft.max" inputmode="decimal" placeholder="10.2" />
              </label>
            </div>
            <p class="hint" style="margin-top:6px">等于上下限算合格；只填一边就是「≤ 上限」或「≥ 下限」。</p>
          </template>

          <template v-if="itemDialog.draft.type === 'bool'">
            <div class="inspect-head" style="margin-top:12px">
              <div>
                <span class="hint" style="margin:0">合格答案是</span>
                <div class="pickgroup">
                  <button type="button" class="pick" :class="{ active: itemDialog.draft.expect === 'no' }" @click="itemDialog.draft.expect = 'no'">无 / 否</button>
                  <button type="button" class="pick" :class="{ active: itemDialog.draft.expect === 'yes' }" @click="itemDialog.draft.expect = 'yes'">有 / 是</button>
                </div>
              </div>
            </div>
          </template>

          <template v-if="itemDialog.draft.type === 'option'">
            <div class="inspect-head" style="margin-top:12px">
              <label>
                <span class="hint" style="margin:0">全部选项（用 / 分隔）</span>
                <el-input v-model="itemDialog.draft.optionsText" placeholder="无 / 轻微 / 明显" />
              </label>
              <label>
                <span class="hint" style="margin:0">哪些算合格（用 / 分隔）</span>
                <el-input v-model="itemDialog.draft.okOptionsText" placeholder="无 / 轻微" />
              </label>
            </div>
          </template>

          <div style="margin-top:12px">
            <span class="hint" style="margin:0">给检验员的一句话提示</span>
            <el-input v-model="itemDialog.draft.hint" placeholder="例：用千分尺量板料原始厚度，避开压印区" />
          </div>

          <template #footer>
            <el-button @click="itemDialog.open = false">取消</el-button>
            <el-button type="primary" @click="saveItem">确定</el-button>
          </template>
        </el-dialog>
      </template>

      <!-- ==================================================================
           数据与设置
           ================================================================== -->
      <template v-if="view === 'data'">
        <section class="card">
          <h2>本机存储</h2>
          <p class="hint">
            所有记录、异常单、照片都只存在这台设备上，没有任何上传。
            <span v-if="!online">当前没网也完全不影响使用。</span>
          </p>
          <div class="grid c3">
            <div class="stat">
              <div class="k">存储方式</div>
              <div class="v small">{{ storage.label || '—' }}</div>
              <div class="k">{{ storage.persistent ? '刷新 / 关机重开都还在' : '⚠ 刷新后会丢，请改用标准浏览器' }}</div>
            </div>
            <div class="stat">
              <div class="k">已用空间</div>
              <div class="v small">{{ formatBytes(usage.usedBytes) }}</div>
              <div class="k">记录 {{ records.length }} 笔 · 异常 {{ anomalies.length }} 张 · 照片 {{ photos.length }} 张</div>
            </div>
            <div class="stat">
              <div class="k">容量上限</div>
              <div class="v small">{{ usage.quotaBytes ? formatBytes(usage.quotaBytes) : '浏览器未提供' }}</div>
              <div class="k" v-if="usagePct !== null">已用 {{ usagePct }}%</div>
              <div class="k" v-else>建议每周导出一次备份</div>
            </div>
          </div>

          <div v-if="storage.fallbacks && storage.fallbacks.length" class="banner warn" style="margin-top:12px">
            <div>
              <div class="bt">降级记录</div>
              <div class="bd">
                <div v-for="f in storage.fallbacks" :key="f.name">{{ f.label }}：{{ f.reason }}</div>
              </div>
            </div>
          </div>

          <div class="banner" :class="usage.advice.level === 'critical' ? 'fail' : usage.advice.level === 'warn' ? 'warn' : 'info'" style="margin-top:12px">
            <div>
              <div class="bt">{{ usage.advice.title }}</div>
              <div class="bd">{{ usage.advice.message }}</div>
            </div>
          </div>
        </section>

        <section class="card">
          <h2>备份与清理</h2>
          <p class="hint">空间不够时按这个顺序走：先导出，再清理。照片最占地方，可以先删旧照片、保留数据。</p>
          <div class="row">
            <el-button type="primary" @click="exportJsonBackup">导出全部数据（JSON 备份）</el-button>
            <el-button @click="exportAllCsv">导出全部记录（CSV）</el-button>
            <el-button @click="exportAnomalyCsv">导出异常单（CSV）</el-button>
            <el-button :loading="importBusy" @click="$refs.backupInput.click()">从备份导入</el-button>
            <input ref="backupInput" type="file" accept="application/json,.json" class="visually-hidden" @change="onImportBackup" />
          </div>
          <div class="row" style="margin-top:12px">
            <span class="hint" style="margin:0">只保留最近</span>
            <input class="big-input" style="max-width:120px" inputmode="numeric" v-model.number="purgeDays" aria-label="保留天数" />
            <span class="hint" style="margin:0">天的记录</span>
            <el-button @click="doPurge">导出并清理旧批次</el-button>
            <el-button @click="dropOldPhotos">删掉 7 天前的照片（记录保留）</el-button>
          </div>
          <p class="hint" style="margin-top:8px">
            当前按这个设置会清掉 {{ records.filter(r => r.createdAt < Date.now() - purgeDays * 86400000).length }} 笔记录。
          </p>
          <div class="row" style="margin-top:12px">
            <el-button type="danger" plain @click="doClearAll">清空本机全部数据</el-button>
            <el-button @click="refreshAll">重新读取本机数据</el-button>
          </div>
        </section>

        <section class="card">
          <h2>可选：自己带 Key 的 AI（默认关闭）</h2>
          <p class="hint">
            本产品默认完全离线、不发任何请求。只有你在这里填了自己的 Key 并打开开关，「用 AI 归类客户投诉」这一个按钮才会联网。
            Key 只存在这台设备的本机存储里。不填也照样能用 —— 投诉归类有纯离线的规则版。
          </p>
          <div class="row">
            <button type="button" class="pick" :class="{ active: settings.aiEnabled }" @click="settings.aiEnabled = !settings.aiEnabled">
              {{ settings.aiEnabled ? '已启用 AI 归类（会联网）' : 'AI 归类：已关闭（纯离线）' }}
            </button>
            <el-button :loading="aiBusy" @click="testAi">测试连通性</el-button>
            <el-button type="primary" @click="saveSettings">保存设置</el-button>
          </div>
          <div class="inspect-head" style="margin-top:12px">
            <label>
              <span class="hint" style="margin:0">接口地址</span>
              <el-input v-model="settings.aiEndpoint" :disabled="!settings.aiEnabled" />
            </label>
            <label>
              <span class="hint" style="margin:0">模型</span>
              <el-input v-model="settings.aiModel" :disabled="!settings.aiEnabled" />
            </label>
            <label>
              <span class="hint" style="margin:0">Key（只存本机）</span>
              <el-input v-model="settings.aiKey" type="password" show-password :disabled="!settings.aiEnabled" />
            </label>
          </div>
        </section>

        <section class="card">
          <h2>现场用起来该注意什么</h2>
          <ul class="hint" style="margin-left:-8px">
            <li>平板建议用 Chrome / Edge 打开，并「添加到主屏幕」，现场就是一键进。</li>
            <li>不要把浏览器设成「退出时清除数据」，那会把本机台账一起清掉。</li>
            <li>每台平板各自存各自的记录；交接班时用「导出 CSV」把手上的数据交出去。</li>
            <li>换平板 / 换人之前，务必先点一次「导出全部数据（JSON 备份）」。</li>
            <li>本机空间到 75% 就会有提醒，看到提醒先导出再清理旧批次。</li>
          </ul>
        </section>
      </template>

      <!-- ============ 异常单对话框（放在视图之外：现场保存和事后补开都要用它） ============ -->
      <el-dialog v-model="anomalyDialog.open" title="开一张异常单" width="min(660px, 96vw)" :close-on-click-modal="false">
        <p class="hint">
          超限项：
          <span v-for="f in anomalyDialog.failed" :key="f.name" class="tag crit" style="margin-right:6px">
            {{ f.name }} = {{ valueText(f) }}{{ f.unit }}（{{ f.limit }}）
          </span>
        </p>
        <div class="banner info" style="margin-bottom:12px">
          <div>
            <div class="bt">系统建议：{{ LEVEL_MAP[anomalyDialog.suggested] ? LEVEL_MAP[anomalyDialog.suggested].label : '—' }}</div>
            <div class="bd">{{ anomalyDialog.suggestedReason }}<br />等级由你确认，系统不替你拍板；「让步接收」必须填核准人。</div>
          </div>
        </div>

        <span class="pick-label">处理等级</span>
        <div class="pickgroup">
          <button
            v-for="l in LEVELS"
            :key="l.value"
            type="button"
            class="pick"
            :class="{ active: anomalyDialog.level === l.value }"
            :title="l.desc"
            @click="anomalyDialog.level = l.value"
          >
            {{ l.label }}
          </button>
        </div>
        <p class="hint" style="margin:8px 0 0">{{ LEVEL_MAP[anomalyDialog.level].desc }}</p>

        <div class="inspect-head" style="margin-top:12px">
          <label>
            <span class="hint" style="margin:0">原因 / 现象</span>
            <el-input v-model="anomalyDialog.reason" type="textarea" :rows="2" />
          </label>
          <label>
            <span class="hint" style="margin:0">处置人</span>
            <input class="text-input" list="qc-inspector-list" v-model="anomalyDialog.handler" aria-label="处置人" placeholder="谁负责处理" />
          </label>
          <label v-if="anomalyDialog.level === 'concession'">
            <span class="hint" style="margin:0">核准人（让步接收必填）*</span>
            <input class="text-input" v-model="anomalyDialog.approvedBy" aria-label="核准人" placeholder="品质主管姓名" />
          </label>
        </div>

        <template #footer>
          <el-button @click="cancelAnomaly">先不开单</el-button>
          <el-button
            type="primary"
            :disabled="anomalyDialog.level === 'concession' && !anomalyDialog.approvedBy"
            @click="confirmAnomaly()"
          >
            建立异常单
          </el-button>
        </template>
      </el-dialog>

      <!-- ============ 底部 ============ -->
      <footer class="hint no-print" style="margin-top:24px;text-align:center">
        车间质检本。纯本机运行，不发任何外部请求，记录与照片都不出这台设备。MIT License，另见
        <a href="./README.md">README</a> 与
        <a href="./pitch.md">pitch</a>。
      </footer>
    </template>
  </main>
</div>
  `,
});

const icons = window.ElementPlusIconsVue || {};
for (const [name, comp] of Object.entries(icons)) app.component(name, comp);

app.use(window.ElementPlus);
app.mount('#app');
