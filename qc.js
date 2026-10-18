/**
 * 车间质检本 · 领域逻辑层（纯函数，可在 Node 下直接测试）
 *
 * 这里放的是「质检这门生意本身的规矩」，不含任何界面与存储代码：
 *   1. 判定 —— 数值比上下限、是/否、选项、文字
 *   2. 异常分级 —— 由判定结果推出该报什么级别的异常单
 *   3. 追溯 —— 按批号/工单/机台/时间/检验员/不良项查记录
 *   4. 报表 —— 批次量、不良率、Top 不良项、未关闭异常
 *
 * 之所以把这些规矩抽出来：判定错了就是漏检，分级错了就是客诉时找不到证据，
 * 所以它们必须有独立的单元测试，不能只活在界面里。
 */

/* ==========================================================================
   0. 常量
   ========================================================================== */

/** 检查项类型 */
export const ITEM_TYPES = [
  { value: 'number', label: '数值（比上下限）', hint: '例：外径 9.8 – 10.2 mm' },
  { value: 'bool', label: '是 / 否', hint: '例：有无毛刺（有个「合格答案」）' },
  { value: 'option', label: '选项', hint: '例：表面处理 = 电镀 / 喷砂 / 无' },
  { value: 'text', label: '文字', hint: '例：外观描述，不自动判定' },
];

/** 单一项的判定结果 */
export const STATUS = ['pass', 'fail', 'empty', 'invalid', 'na'];

/** 严重度：决定异常分级 */
export const SEVERITIES = [
  { value: 'critical', label: '关键（安全 / 关键尺寸）' },
  { value: 'major', label: '主要（功能 / 装配）' },
  { value: 'minor', label: '次要（外观 / 包装）' },
];

/** 异常分级：前三个可由判定自动推出，让步接收必须人工决定 */
export const LEVELS = [
  {
    value: 'scrap',
    label: '报废',
    tone: 'danger',
    auto: true,
    desc: '不可修复或触及安全项，直接报废，计入损失。',
  },
  {
    value: 'isolate',
    label: '隔离',
    tone: 'warning',
    auto: true,
    desc: '先隔离挂标识，等品质主管判定，不得流入下工序。',
  },
  {
    value: 'rework',
    label: '返工',
    tone: 'primary',
    auto: true,
    desc: '可修复，返工后必须重新检验这一项。',
  },
  {
    value: 'concession',
    label: '让步接收',
    tone: 'info',
    auto: false,
    desc: '偏差在客户可接受范围内：必须由品质主管核准并写明理由。',
  },
];

export const LEVEL_MAP = Object.fromEntries(LEVELS.map((l) => [l.value, l]));

/** 抽样频率候选（模板里直接引用这些字符串） */
export const FREQUENCIES = ['首件', '每 30 分钟', '每 1 小时', '每 2 小时', '每班次', '每批', '每 500 件'];

/** 分级阈值：超出规格带的多少倍算「严重超限」 */
export const SEVERITY_OVER = { scrap: 0.5, isolate: 0.15 };

/* ==========================================================================
   1. 小工具
   ========================================================================== */

let seq = 0;

/** 生成本机唯一 id（不用随机数也行，但加随机可避开同一毫秒连点） */
export function newId(prefix = 'r') {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function toNumber(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const s = String(value).trim().replace(/[，,]/g, '');
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export function round(n, digits = 3) {
  if (!Number.isFinite(n)) return n;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

/** 2026-10-18 */
export function dayKey(ts) {
  const d = new Date(ts);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 2026-10-18 14:32 */
export function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  return `${dayKey(ts)} ${hh}:${mm}`;
}

/** 该检查项默认的严重度 */
export function defaultSeverity(item) {
  if (item && item.severity) return item.severity;
  if (!item) return 'major';
  return item.type === 'number' || item.type === 'bool' ? 'major' : 'minor';
}

/** 去掉首尾空白并压缩中间空白，用于比对选项 */
function normText(v) {
  return String(v ?? '').trim().replace(/\s+/g, ' ');
}

/** 规格的书面写法，用在界面上和导出里：9.8 – 10.2 mm */
export function specText(item) {
  const unit = item?.unit ? ` ${item.unit}` : '';
  const hasMin = Number.isFinite(item?.min);
  const hasMax = Number.isFinite(item?.max);
  if (item?.type === 'number') {
    if (hasMin && hasMax) return `${item.min} – ${item.max}${unit}`;
    if (hasMax) return `≤ ${item.max}${unit}`;
    if (hasMin) return `≥ ${item.min}${unit}`;
    return '只记录数值';
  }
  if (item?.type === 'bool') return item.expect === 'no' ? '要求：无' : item.expect === 'yes' ? '要求：有' : '只记录';
  if (item?.type === 'option') return item.okOptions?.length ? `可接受：${item.okOptions.join(' / ')}` : '只记录';
  return '文字记录';
}

/** 一个模板「全项合格」时该填什么值 —— 示例数据与「带入标准值」都用它 */
export function nominalValue(item) {
  if (item.type === 'number') {
    const hasMin = Number.isFinite(item.min);
    const hasMax = Number.isFinite(item.max);
    if (hasMin && hasMax) return round((item.min + item.max) / 2, 3);
    if (hasMax) return round(item.max * 0.8, 3);
    if (hasMin) return round(item.min * 1.2, 3);
    return 1;
  }
  if (item.type === 'bool') return item.expect !== 'no';
  if (item.type === 'option') return item.okOptions?.[0] ?? item.options?.[0] ?? '';
  return '外观正常';
}

export function passingValues(template) {
  const out = {};
  for (const item of template?.items || []) out[item.id] = nominalValue(item);
  return out;
}

/* ==========================================================================
   2. 逐项判定
   ========================================================================== */

/**
 * 判定一个检查项的实测值。
 * @returns {{ status: string, label: string, reason: string, value: any,
 *             overRatio: number, severity: string }}
 */
export function judgeItem(item, rawValue) {
  const severity = defaultSeverity(item);
  const base = { value: rawValue, overRatio: 0, severity, itemId: item?.id, name: item?.name, type: item?.type || 'number' };
  const type = item?.type || 'number';

  // 未填：空字符串、null、undefined 都算没填。
  // 是/否项要特别注意：undefined 是「没回答」，false 是「回答了否」，两者不能混为一谈——
  // 否则检验员什么都没点，系统就会报「不合格」。
  const blank =
    rawValue === null ||
    rawValue === undefined ||
    (typeof rawValue === 'string' && rawValue.trim() === '');
  if (blank) {
    return { ...base, status: 'empty', label: '未填', reason: '这一项还没填' };
  }

  if (type === 'number') {
    const v = toNumber(rawValue);
    if (!Number.isFinite(v)) {
      return { ...base, status: 'invalid', label: '填错', reason: `「${rawValue}」不是数字` };
    }
    const { min, max } = item;
    const hasMin = Number.isFinite(min);
    const hasMax = Number.isFinite(max);
    const unit = item.unit ? ` ${item.unit}` : '';
    // 上下限都是闭区间：等于上下限算合格（车间的「够到就算数」习惯）
    if (hasMin && v < min) {
      return {
        ...base,
        status: 'fail',
        label: '偏低',
        reason: `${v}${unit} 低于下限 ${min}${unit}`,
        overRatio: overRatio(item, v),
      };
    }
    if (hasMax && v > max) {
      return {
        ...base,
        status: 'fail',
        label: '偏高',
        reason: `${v}${unit} 高于上限 ${max}${unit}`,
        overRatio: overRatio(item, v),
      };
    }
    const spec = hasMin && hasMax ? `${min} – ${max}${unit}` : hasMax ? `≤ ${max}${unit}` : `≥ ${min}${unit}`;
    return { ...base, status: 'pass', label: '合格', reason: `${v}${unit} 在规格内（${spec}）` };
  }

  if (type === 'bool') {
    const v = rawValue === true || rawValue === 'yes' || rawValue === 'true' || rawValue === 1;
    const expect = item.expect === 'no' ? false : item.expect === 'yes' ? true : null;
    const word = v ? '是' : '否';
    if (expect === null) {
      return { ...base, status: 'pass', label: word, reason: `记录：${word}` };
    }
    if (v === expect) {
      return { ...base, status: 'pass', label: word, reason: `结果「${word}」，符合要求` };
    }
    return {
      ...base,
      status: 'fail',
      label: word,
      reason: `结果为「${word}」，要求是「${expect ? '是' : '否'}」`,
      overRatio: 1,
    };
  }

  if (type === 'option') {
    const v = normText(rawValue);
    const ok = (item.okOptions || []).map(normText).filter(Boolean);
    if (!ok.length) {
      return { ...base, status: 'pass', label: v, reason: `记录：${v}` };
    }
    if (ok.includes(v)) {
      return { ...base, status: 'pass', label: v, reason: `属于可接受选项（${ok.join(' / ')}）` };
    }
    return {
      ...base,
      status: 'fail',
      label: v,
      reason: `「${v}」不在可接受范围（${ok.join(' / ')}）`,
      overRatio: 1,
    };
  }

  // text：质检员自己看的东西，系统不替人下结论
  const v = normText(rawValue);
  return { ...base, status: 'pass', label: v.slice(0, 8), reason: '文字记录，需人工判读' };
}

/**
 * 超出规格的严重程度：0 = 刚好卡在限上，0.5 = 超出的量已达规格带的一半。
 * 用来给异常分级，不做展示。
 * 参照宽度：双边规格用带宽；只有单边规格时用限值本身
 * （「上限 0.05 却量到 0.11」= 超出 120%，这个读法车间一听就懂）。
 */
export function overRatio(item, v) {
  const { min, max } = item;
  const hasMin = Number.isFinite(min);
  const hasMax = Number.isFinite(max);
  let span = hasMin && hasMax ? max - min : 0;
  if (!(span > 0)) {
    const ref = Math.abs(hasMax ? max : hasMin ? min : 1);
    span = ref > 0 ? ref : 1;
  }
  let excess = 0;
  if (hasMax && v > max) excess = v - max;
  else if (hasMin && v < min) excess = min - v;
  if (!(excess > 0)) return 0;
  // 不封顶：超出规格带 3 倍就该直接报废，界面上的百分比也要看得出差距
  return round(excess / span, 3);
}

/** 必填项是否缺失 */
export function isMissing(item, rawValue) {
  if (!item?.required) return false;
  if (item.type === 'bool') return rawValue === null || rawValue === undefined;
  return rawValue === null || rawValue === undefined || String(rawValue).trim() === '';
}

/**
 * 判定一整张记录：逐项判 + 汇总。
 * @param {object} template 检查项模板
 * @param {object} values   { [itemId]: rawValue }
 */
export function judgeRecord(template, values = {}) {
  const items = template?.items || [];
  // 记录里存的是「判定 + 当时的规格」：规格是历史事实，模板以后改了也不能影响旧记录
  const results = items.map((item) => ({
    ...judgeItem(item, values[item.id]),
    name: item.name,
    unit: item.unit || '',
    min: Number.isFinite(item.min) ? item.min : null,
    max: Number.isFinite(item.max) ? item.max : null,
    type: item.type,
    frequency: item.frequency || '',
    required: item.required !== false,
    limit: specText(item),
  }));
  const failed = results.filter((r) => r.status === 'fail');
  const missing = items.filter((item) => isMissing(item, values[item.id]));
  const invalid = results.filter((r) => r.status === 'invalid');
  const counted = results.filter((r) => r.status === 'pass' || r.status === 'fail');
  const verdict = failed.length ? 'fail' : missing.length || invalid.length ? 'incomplete' : 'pass';
  return {
    results,
    failed,
    missing: missing.map((m) => ({ id: m.id, name: m.name })),
    invalid,
    counted: counted.length,
    verdict,
  };
}

/* ==========================================================================
   3. 异常分级
   ========================================================================== */

/**
 * 由超限项推出建议的异常等级。
 * 规则（界面上原样写着，让质检员知道系统为什么这么判）：
 *   1) 关键项不合格 → 报废
 *   2) 主要项不合格：偏离规格带 50% 以上 → 报废，否则 → 隔离
 *   3) 只剩次要项不合格 → 返工
 * 注意两点：
 *   - 是/否与选项这两类（毛刺、色差、虚焊…）不参与「偏离多少」的计算，
 *     它们的处置由严重度说了算，不然「有毛刺」会被离谱地判成报废；
 *   - 「让步接收」永远不会被自动选中，那是品质主管签字的动作。
 */
export function suggestLevel(failedItems = []) {
  const fails = failedItems.filter((r) => r && r.status !== 'pass' && r.status !== 'empty');
  if (!fails.length) return { level: null, reason: '没有超限项，不需要开异常单', hits: [] };

  const critical = fails.filter((r) => defaultSeverity(r) === 'critical');
  if (critical.length) {
    return {
      level: 'scrap',
      reason: `关键项「${critical[0].name}」不合格（关键项不合格一律按报废处理）`,
      hits: critical,
    };
  }

  const major = fails.filter((r) => defaultSeverity(r) === 'major');
  if (major.length) {
    const overHalf = major.filter((r) => r.type === 'number' && (r.overRatio || 0) >= SEVERITY_OVER.scrap);
    if (overHalf.length) {
      return {
        level: 'scrap',
        reason: `主要项「${overHalf[0].name}」偏离规格带 ${Math.round((overHalf[0].overRatio || 0) * 100)}%，偏差过大修不回来`,
        hits: overHalf,
      };
    }
    return {
      level: 'isolate',
      reason: `主要项「${major[0].name}」不合格，先隔离挂标识等判定`,
      hits: major,
    };
  }

  return {
    level: 'rework',
    reason: `次要项「${fails[0].name}」轻微偏差，返工后重检即可`,
    hits: fails,
  };
}

/** 建立一张异常单（纯数据，不落库） */
export function buildAnomaly(record, failedItems, extra = {}) {
  const s = suggestLevel(failedItems);
  const level = extra.level || s.level || 'rework';
  if (level === 'concession' && !extra.approvedBy) {
    throw new Error('让步接收必须填写核准人');
  }
  return {
    id: newId('a'),
    recordId: record.id,
    createdAt: Date.now(),
    level,
    suggestedLevel: s.level,
    autoReason: s.reason,
    reason: extra.reason || s.reason,
    batchNo: record.batchNo,
    workOrder: record.workOrder,
    machine: record.machine,
    inspector: record.inspector,
    failedItems: failedItems.map((f) => ({
      itemId: f.itemId,
      name: f.name,
      // 异常单是给人看的单子：是/否要写「是」「否」，不能印个 false 出来
      value: f.type === 'bool' ? (f.value ? '是' : '否') : f.value,
      rawValue: f.value,
      unit: f.unit,
      limit: f.limit,
      reason: f.reason,
      severity: f.severity,
    })),
    handler: extra.handler || '',
    handledAt: extra.handledAt || null,
    approvedBy: extra.approvedBy || '',
    closed: false,
    closedAt: null,
    closureNote: '',
  };
}

/** 关闭异常单 */
export function closeAnomaly(anomaly, { closedAt = Date.now(), closureNote = '', handler } = {}) {
  if (!closureNote || !closureNote.trim()) {
    throw new Error('关闭异常单必须写明处理结果');
  }
  return {
    ...anomaly,
    closed: true,
    closedAt,
    closureNote: closureNote.trim(),
    handler: handler || anomaly.handler,
    handledAt: anomaly.handledAt || closedAt,
  };
}

/* ==========================================================================
   4. 追溯查询
   ========================================================================== */

/**
 * 按任一条件筛记录。空条件 = 不筛。
 *
 * 关键字（keyword）只比对「能认出问题的字」：批号、工单、机台、检验员、模板名、备注、
 * 异常等级、关联异常单（原因 / 处置人 / 处理结果），以及**不合格 / 填错 / 未填的检查项**
 * 和文字记录项。故意不比对全部检查项名——否则搜「熔接痕」会把每一笔塑胶记录都捞出来，
 * 而客诉时真正想找的是「哪一批的熔接痕出过问题」。
 *
 * @param {Array} records
 * @param {object} f { batchNo, workOrder, machine, inspector, from, to, verdict, keyword, level }
 * @param {object} opts { anomalyMap } 传了就能一起搜异常单的内容（客诉常常只记得处置经过）
 */
export function queryRecords(records = [], f = {}, { anomalyMap } = {}) {
  const like = (v, q) => normText(v).toLowerCase().includes(normText(q).toLowerCase());
  const kw = normText(f.keyword).toLowerCase();
  const anomalyOf = (r) => (anomalyMap && r.anomalyId ? anomalyMap[r.anomalyId] : null);

  return records
    .filter((r) => {
      const a = anomalyOf(r);
      if (f.batchNo && !like(r.batchNo, f.batchNo)) return false;
      if (f.workOrder && !like(r.workOrder, f.workOrder)) return false;
      if (f.machine && !like(r.machine, f.machine)) return false;
      if (f.inspector && !like(r.inspector, f.inspector)) return false;
      if (f.verdict && f.verdict !== 'all' && r.verdict !== f.verdict) return false;
      if (f.from && r.createdAt < f.from) return false;
      if (f.to && r.createdAt > f.to) return false;
      if (f.level && f.level !== 'all' && (r.anomalyLevel || '') !== f.level) return false;
      if (kw) {
        const hay = [
          r.batchNo,
          r.workOrder,
          r.machine,
          r.inspector,
          r.templateName,
          r.note,
          r.anomalyLevel,
          ...(r.results || [])
            .filter((x) => x.status === 'fail' || x.status === 'invalid' || x.status === 'empty' || x.type === 'text')
            .map((x) => `${x.name} ${x.value} ${x.reason}`),
        ];
        if (a) hay.push(a.reason, a.handler, a.closureNote, a.approvedBy);
        if (!hay.some((h) => like(h, kw))) return false;
      }
      return true;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 把记录压成一行展示用的摘要（照片数量、判定、异常等级都带上） */
export function summarizeRecord(record) {
  const failedNames = (record.results || []).filter((r) => r.status === 'fail').map((r) => r.name);
  return {
    id: record.id,
    createdAt: record.createdAt,
    when: formatDateTime(record.createdAt),
    workOrder: record.workOrder || '—',
    batchNo: record.batchNo || '—',
    machine: record.machine || '—',
    inspector: record.inspector || '—',
    templateName: record.templateName || '—',
    verdict: record.verdict,
    verdictLabel:
      record.verdict === 'fail' ? '不合格' : record.verdict === 'pass' ? '合格' : '未完成',
    failedCount: failedNames.length,
    failedNames,
    photoCount: (record.photos || []).length,
    anomalyId: record.anomalyId || '',
    anomalyLevel: record.anomalyLevel || '',
    anomalyLevelLabel: record.anomalyLevel ? LEVEL_MAP[record.anomalyLevel]?.label || '' : '',
    note: record.note || '',
  };
}

/* ==========================================================================
   5. 报表
   ========================================================================== */

/** 时间窗：granularity = day（当天）| week（近 7 天）| month（近 30 天） */
export function resolveWindow(granularity = 'week', now = Date.now()) {
  const end = now;
  const days = granularity === 'day' ? 1 : granularity === 'month' ? 30 : 7;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return { from: start.getTime(), to: end, days, granularity };
}

/**
 * 日报 / 周报。
 * @returns 批次量、不良率、Top 不良项、未关闭异常、分日趋势、按检验员统计
 */
export function buildReport({ records = [], anomalies = [], granularity = 'week', now = Date.now() } = {}) {
  const win = resolveWindow(granularity, now);
  const inWin = records
    .filter((r) => r.createdAt >= win.from && r.createdAt <= win.to)
    .sort((a, b) => a.createdAt - b.createdAt);

  const prevFrom = win.from - win.days * 86400000;
  const prev = records.filter((r) => r.createdAt >= prevFrom && r.createdAt < win.from);

  const allInWin = records.filter((r) => r.createdAt >= win.from && r.createdAt <= win.to);

  const batches = inWin.length;
  const failBatches = inWin.filter((r) => r.verdict === 'fail').length;
  const incomplete = inWin.filter((r) => r.verdict === 'incomplete').length;

  // 项次级不良率：不合格的检查项 / 已判定的检查项
  let checkedItems = 0;
  let failedItems = 0;
  const defectTally = new Map();
  for (const r of inWin) {
    for (const x of r.results || []) {
      if (x.status === 'pass' || x.status === 'fail') checkedItems += 1;
      if (x.status === 'fail') {
        failedItems += 1;
        const key = x.name || '(未命名)';
        const cur = defectTally.get(key) || { name: key, count: 0, unit: x.unit || '', lastValue: x.value, lastReason: x.reason };
        cur.count += 1;
        cur.lastValue = x.value;
        cur.lastReason = x.reason;
        defectTally.set(key, cur);
      }
    }
  }

  const byDayMap = new Map();
  for (let i = 0; i < win.days; i += 1) {
    const d = new Date(win.from);
    d.setDate(d.getDate() + i);
    byDayMap.set(dayKey(d.getTime()), { key: dayKey(d.getTime()), label: dayKey(d.getTime()).slice(5), batches: 0, fail: 0 });
  }
  for (const r of inWin) {
    const cell = byDayMap.get(dayKey(r.createdAt));
    if (!cell) continue;
    cell.batches += 1;
    if (r.verdict === 'fail') cell.fail += 1;
  }

  const inspectorMap = new Map();
  for (const r of inWin) {
    const key = r.inspector || '(未填)';
    const cur = inspectorMap.get(key) || { name: key, batches: 0, fail: 0, photos: 0 };
    cur.batches += 1;
    if (r.verdict === 'fail') cur.fail += 1;
    cur.photos += (r.photos || []).length;
    inspectorMap.set(key, cur);
  }

  const openAnomalies = anomalies.filter((a) => !a.closed);
  const levels = {};
  for (const l of LEVELS) levels[l.value] = 0;
  for (const a of anomalies.filter((a) => a.createdAt >= win.from && a.createdAt <= win.to)) {
    levels[a.level] = (levels[a.level] || 0) + 1;
  }

  const closedInWin = anomalies.filter((a) => a.closed && a.closedAt >= win.from && a.closedAt <= win.to);
  const avgCloseHours = closedInWin.length
    ? round(
        closedInWin.reduce((s, a) => s + (a.closedAt - a.createdAt), 0) / closedInWin.length / 3600000,
        1,
      )
    : null;

  const prevFail = prev.filter((r) => r.verdict === 'fail').length;

  return {
    granularity,
    from: win.from,
    to: win.to,
    label: granularity === 'day' ? `日报 · ${dayKey(win.from)}` : granularity === 'month' ? '月报 · 近 30 天' : '周报 · 近 7 天',
    batches,
    failBatches,
    incomplete,
    passBatches: batches - failBatches - incomplete,
    defectBatchRate: batches ? round(failBatches / batches, 4) : 0,
    checkedItems,
    failedItems,
    defectItemRate: checkedItems ? round(failedItems / checkedItems, 4) : 0,
    topDefects: [...defectTally.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 8),
    byDay: [...byDayMap.values()],
    inspectors: [...inspectorMap.values()].sort((a, b) => b.batches - a.batches),
    levels,
    openAnomalies: openAnomalies.sort((a, b) => a.createdAt - b.createdAt),
    openCount: openAnomalies.length,
    closedInWindow: closedInWin.length,
    avgCloseHours,
    prevBatches: prev.length,
    prevDefectBatchRate: prev.length ? round(prevFail / prev.length, 4) : 0,
    generatedAt: now,
    totalRecords: allInWin.length,
  };
}

/* ==========================================================================
   6. 导出
   ========================================================================== */

/** CSV：带 BOM，Excel 打开中文不乱码；字段里有逗号/引号/换行都正确转义 */
export function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => esc(c.get(row))).join(',')).join('\r\n');
  return `\uFEFF${head}\r\n${body}\r\n`;
}

/**
 * CSV 里怎么显示实测值：是/否写成中文，没填写「—」。
 * 交上去给主管看的表格里出现 true / false / undefined 很难看，也容易被误读。
 * 要原始数据请用 JSON 备份，那里一个字段都不动。
 */
export function displayValue(value, type) {
  if (type === 'bool') return value === true ? '是' : value === false ? '否' : '—';
  if (value === null || value === undefined || String(value).trim() === '') return '—';
  return value;
}

const RECORD_COLUMNS = [
  { label: '记录号', get: (r) => r.id },
  { label: '时间', get: (r) => formatDateTime(r.createdAt) },
  { label: '工单', get: (r) => r.workOrder },
  { label: '批号', get: (r) => r.batchNo },
  { label: '机台', get: (r) => r.machine },
  { label: '检验员', get: (r) => r.inspector },
  { label: '模板', get: (r) => r.templateName },
  { label: '结论', get: (r) => (r.verdict === 'fail' ? '不合格' : r.verdict === 'pass' ? '合格' : '未完成') },
  { label: '异常等级', get: (r) => (r.anomalyLevel ? LEVEL_MAP[r.anomalyLevel]?.label : '') },
  { label: '检查项', get: (r) => (r.results || []).map((x) => x.name).join(' / ') },
  { label: '实测值', get: (r) => (r.results || []).map((x) => displayValue(x.value, x.type)).join(' / ') },
  { label: '项判定', get: (r) => (r.results || []).map((x) => (x.status === 'fail' ? '不合格' : x.status === 'pass' ? '合格' : x.status)).join(' / ') },
  { label: '照片数', get: (r) => (r.photos || []).length },
  { label: '备注', get: (r) => r.note },
];

/** 一条记录一行（检查项并成多列，方便 Excel 里筛） */
export function recordsToCsv(records) {
  return toCsv(records, RECORD_COLUMNS);
}

/** 一条记录一项一行（长表，给 SPSS / 质量分析用） */
export function recordsToLongCsv(records) {
  const rows = [];
  for (const r of records) {
    for (const x of r.results || []) {
      rows.push({ r, x });
    }
  }
  return toCsv(rows, [
    { label: '记录号', get: ({ r }) => r.id },
    { label: '时间', get: ({ r }) => formatDateTime(r.createdAt) },
    { label: '工单', get: ({ r }) => r.workOrder },
    { label: '批号', get: ({ r }) => r.batchNo },
    { label: '机台', get: ({ r }) => r.machine },
    { label: '检验员', get: ({ r }) => r.inspector },
    { label: '检查项', get: ({ x }) => x.name },
    { label: '下限', get: ({ x }) => x.min },
    { label: '上限', get: ({ x }) => x.max },
    { label: '单位', get: ({ x }) => x.unit },
    { label: '实测', get: ({ x }) => displayValue(x.value, x.type) },
    { label: '判定', get: ({ x }) => (x.status === 'fail' ? '不合格' : x.status === 'pass' ? '合格' : x.status) },
    { label: '说明', get: ({ x }) => x.reason },
  ]);
}

/** 异常单导出 */
export function anomaliesToCsv(anomalies) {
  const lvl = (v) => LEVEL_MAP[v]?.label || v;
  return toCsv(anomalies, [
    { label: '异常单号', get: (a) => a.id },
    { label: '开单时间', get: (a) => formatDateTime(a.createdAt) },
    { label: '等级', get: (a) => lvl(a.level) },
    { label: '批号', get: (a) => a.batchNo },
    { label: '工单', get: (a) => a.workOrder },
    { label: '机台', get: (a) => a.machine },
    { label: '检验员', get: (a) => a.inspector },
    { label: '不良项', get: (a) => (a.failedItems || []).map((f) => f.name).join(' / ') },
    { label: '不良值', get: (a) => (a.failedItems || []).map((f) => f.value ?? '').join(' / ') },
    { label: '原因', get: (a) => a.reason },
    { label: '处置人', get: (a) => a.handler },
    { label: '处置时间', get: (a) => formatDateTime(a.handledAt) },
    { label: '核准人', get: (a) => a.approvedBy },
    { label: '已关闭', get: (a) => (a.closed ? '是' : '否') },
    { label: '关闭时间', get: (a) => formatDateTime(a.closedAt) },
    { label: '处理结果', get: (a) => a.closureNote },
  ]);
}

/** 报表 → Markdown（可直接贴进群里 / 打印） */
export function reportToMarkdown(report, { records = [], anomalies = [] } = {}) {
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const L = [];
  L.push(`# 质检${report.granularity === 'day' ? '日报' : report.granularity === 'month' ? '月报' : '周报'}`);
  L.push('');
  L.push(`- 统计区间：${formatDateTime(report.from)} ～ ${formatDateTime(report.to)}`);
  L.push(`- 生成时间：${formatDateTime(report.generatedAt)}`);
  L.push('');
  L.push('## 一、总量');
  L.push('');
  L.push('| 指标 | 本区间 | 上一区间 |');
  L.push('|---|---|---|');
  L.push(`| 检验批次 | ${report.batches} | ${report.prevBatches} |`);
  L.push(`| 不合格批次 | ${report.failBatches} | — |`);
  L.push(`| 批次不良率 | ${pct(report.defectBatchRate)} | ${pct(report.prevDefectBatchRate)} |`);
  L.push(`| 检查项次 | ${report.checkedItems} | — |`);
  L.push(`| 项次不良率 | ${pct(report.defectItemRate)} | — |`);
  L.push(`| 未关闭异常 | ${report.openCount} | — |`);
  if (report.avgCloseHours !== null) L.push(`| 平均关闭时长 | ${report.avgCloseHours} 小时 | — |`);
  L.push('');
  L.push('## 二、Top 不良项');
  L.push('');
  if (!report.topDefects.length) {
    L.push('本区间没有不合格项。');
  } else {
    L.push('| 排名 | 不良项 | 次数 | 最近实测 |');
    L.push('|---:|---|---:|---|');
    report.topDefects.forEach((d, i) => {
      L.push(`| ${i + 1} | ${d.name} | ${d.count} | ${d.lastValue ?? ''} ${d.unit || ''} |`);
    });
  }
  L.push('');
  L.push('## 三、未关闭异常单');
  L.push('');
  if (!report.openAnomalies.length) {
    L.push('没有未关闭的异常单。');
  } else {
    L.push('| 单号 | 开单时间 | 等级 | 批号 | 机台 | 不良项 | 处置人 |');
    L.push('|---|---|---|---|---|---|---|');
    for (const a of report.openAnomalies) {
      L.push(
        `| ${a.id} | ${formatDateTime(a.createdAt)} | ${LEVEL_MAP[a.level]?.label || a.level} | ${a.batchNo || '—'} | ${a.machine || '—'} | ${(a.failedItems || []).map((f) => f.name).join('/')} | ${a.handler || '（未指派）'} |`,
      );
    }
  }
  L.push('');
  L.push('## 四、按检验员');
  L.push('');
  L.push('| 检验员 | 批次数 | 不合格批次 | 照片留证 |');
  L.push('|---|---:|---:|---:|');
  for (const i of report.inspectors) {
    L.push(`| ${i.name} | ${i.batches} | ${i.fail} | ${i.photos} |`);
  }
  if (!report.inspectors.length) L.push('| — | 0 | 0 | 0 |');
  L.push('');
  L.push('## 五、异常分级分布');
  L.push('');
  for (const l of LEVELS) L.push(`- ${l.label}：${report.levels[l.value] || 0} 张`);
  L.push('');
  if (records.length) {
    L.push(`（本报表基于 ${records.length} 条检验记录、${anomalies.length} 张异常单，全部离线保存在本机。）`);
  }
  return L.join('\n');
}

/* ==========================================================================
   7. 可选：投诉文字归类（规则版，纯离线）
   ========================================================================== */

const KEYWORD_LEXICON = [
  { item: '尺寸', words: ['尺寸', '公差', '大了', '小了', '长了', '短了', '装配', '装不进', '装不上', '偏大', '偏小', '超差'] },
  { item: '外观', words: ['刮伤', '划痕', '刮痕', '碰伤', '毛刺', '毛边', '脏', '油污', '凹陷', '变形', '生锈', '色差', '外观'] },
  { item: '材质', words: ['材质', '材料', '硬度', '太软', '太硬', '成分', '开裂', '脆'] },
  { item: '功能', words: ['不通电', '不工作', '死机', '短路', '接触不良', '功能', '失效', '插不进'] },
  { item: '包装', words: ['包装', '标签', '贴错', '箱', '混料', '数量不对', '少了', '多了'] },
  { item: '焊接', words: ['焊点', '虚焊', '假焊', '焊锡', '脱焊', '冷焊'] },
];

/**
 * 把客户投诉的一段大白话，贴到模板里的检查项上。
 * 优先匹配模板自身的检查项名，其次落到通用词表。
 * 纯规则，不联网——这也是 BYO-Key 不可用时的降级路径。
 */
export function classifyComplaint(text, items = []) {
  const t = normText(text);
  if (!t) return { matches: [], category: '', confidence: 0 };

  const hits = [];
  for (const item of items) {
    const name = normText(item.name);
    if (!name) continue;
    if (t.includes(name)) {
      hits.push({ itemId: item.id, name, hit: name, exact: true });
      continue;
    }
    // 拆词：名字里连续 2 字以上与投诉文本重合
    const grams = [];
    for (let i = 0; i + 2 <= name.length; i += 1) grams.push(name.slice(i, i + 2));
    const g = grams.find((x) => t.includes(x));
    if (g) hits.push({ itemId: item.id, name, hit: g, exact: false });
  }

  if (hits.length) {
    const uniq = [...new Map(hits.map((h) => [h.itemId, h])).values()];
    return {
      matches: uniq,
      category: uniq[0].name,
      confidence: uniq[0].exact ? 0.9 : 0.6,
    };
  }

  const lexHits = [];
  for (const row of KEYWORD_LEXICON) {
    const w = row.words.find((x) => t.includes(x));
    if (w) {
      const item = items.find((i) => normText(i.name).includes(row.item));
      lexHits.push({ itemId: item?.id || '', name: item?.name || row.item, hit: w, exact: false });
    }
  }
  if (lexHits.length) {
    return { matches: lexHits, category: lexHits[0].name, confidence: 0.45 };
  }
  return { matches: [], category: '', confidence: 0 };
}

/**
 * 把示例 + 自定义模板合成一份可用的模板表：保证 id 唯一、检查项有 id。
 */
export function normalizeTemplates(raw = []) {
  return raw.map((t, ti) => {
    const id = t.id || `tpl-${ti + 1}`;
    return {
      id,
      name: normText(t.name) || `模板 ${ti + 1}`,
      industry: t.industry || '',
      note: t.note || '',
      builtin: Boolean(t.builtin),
      items: (t.items || []).map((item, ii) => ({
        id: item.id || `${id}-i${ii + 1}`,
        name: normText(item.name) || `检查项 ${ii + 1}`,
        type: ITEM_TYPES.some((x) => x.value === item.type) ? item.type : 'number',
        unit: item.unit || '',
        min: Number.isFinite(item.min) ? item.min : null,
        max: Number.isFinite(item.max) ? item.max : null,
        expect: item.expect || '',
        okOptions: Array.isArray(item.okOptions) ? item.okOptions : [],
        options: Array.isArray(item.options) ? item.options : [],
        required: item.required !== false,
        frequency: item.frequency || '',
        severity: SEVERITIES.some((s) => s.value === item.severity) ? item.severity : defaultSeverity(item),
        hint: item.hint || '',
      })),
    };
  });
}

/** 模板上一共几项必填 —— 界面进度条与「跑一次」按钮都要用 */
export function templateStats(template) {
  const items = template?.items || [];
  return {
    total: items.length,
    required: items.filter((i) => i.required).length,
    numeric: items.filter((i) => i.type === 'number').length,
    critical: items.filter((i) => defaultSeverity(i) === 'critical').length,
  };
}

/* ==========================================================================
   8. 示例历史（固定、可复现，不随机）
   ========================================================================== */

/**
 * 示例工单的来源：写死 20 笔、跨 6 天，只有 4 笔不合格。
 * 写死不随机是为了两件事：（1）测试能对报表数字下断言；
 * （2）第一次打开产品的人看到的就是一份合理的小厂质检台账，而不是随机噪声。
 * `fail` 里写的是「检查项名称 → 本次实测值」，其余项自动取标准值（必合格）。
 */
export const DEMO_SPECS = [
  { d: -6, h: 8.5, tpl: 'metal', machine: '冲床 #3', inspector: '陈志明', shift: '早班', qty: 1200, note: '首件确认' },
  { d: -6, h: 10.5, tpl: 'plastic', machine: '射出机 #2', inspector: '陈志明', shift: '早班', qty: 800 },
  { d: -6, h: 15, tpl: 'electronics', machine: '组装线 A', inspector: '王建国', shift: '中班', qty: 300 },
  { d: -5, h: 9, tpl: 'metal', machine: '冲床 #3', inspector: '李秀兰', shift: '早班', qty: 1500 },
  { d: -5, h: 10, tpl: 'plastic', machine: '射出机 #1', inspector: '陈志明', shift: '早班', qty: 900 },
  {
    d: -5,
    h: 14,
    tpl: 'metal',
    machine: '冲床 #1',
    inspector: '李秀兰',
    shift: '中班',
    qty: 2000,
    fail: { 折弯角度: 91.8 },
    note: '换模后首件，角度偏了',
  },
  { d: -5, h: 16, tpl: 'electronics', machine: '组装线 A', inspector: '王建国', shift: '中班', qty: 400 },
  { d: -4, h: 9, tpl: 'plastic', machine: '射出机 #2', inspector: '陈志明', shift: '早班', qty: 1000 },
  { d: -4, h: 11, tpl: 'metal', machine: '冲床 #3', inspector: '李秀兰', shift: '早班', qty: 1200 },
  { d: -4, h: 15, tpl: 'electronics', machine: '组装线 B', inspector: '王建国', shift: '中班', qty: 260 },
  {
    d: -3,
    h: 9,
    tpl: 'plastic',
    machine: '射出机 #1',
    inspector: '陈志明',
    shift: '早班',
    qty: 1100,
    fail: { 熔接痕: '明显' },
    note: '模具温度偏低，已通知调机',
  },
  { d: -3, h: 11, tpl: 'metal', machine: '冲床 #1', inspector: '李秀兰', shift: '早班', qty: 1600 },
  {
    d: -3,
    h: 14,
    tpl: 'electronics',
    machine: '组装线 A',
    inspector: '王建国',
    shift: '中班',
    qty: 350,
    fail: { 焊接质量: '虚焊' },
  },
  { d: -3, h: 16, tpl: 'plastic', machine: '射出机 #2', inspector: '陈志明', shift: '中班', qty: 950 },
  { d: -2, h: 9, tpl: 'metal', machine: '冲床 #3', inspector: '李秀兰', shift: '早班', qty: 1400 },
  { d: -2, h: 11, tpl: 'electronics', machine: '组装线 B', inspector: '王建国', shift: '中班', qty: 280 },
  { d: -2, h: 15, tpl: 'plastic', machine: '射出机 #1', inspector: '陈志明', shift: '中班', qty: 1050 },
  { d: -1, h: 9, tpl: 'metal', machine: '冲床 #1', inspector: '李秀兰', shift: '早班', qty: 1800 },
  {
    d: -1,
    h: 10.5,
    tpl: 'electronics',
    machine: '组装线 A',
    inspector: '王建国',
    shift: '早班',
    qty: 320,
    fail: { 通电亮灯: false, 异响: true },
    note: '整批不亮，怀疑电源板来料',
  },
  { d: -1, h: 15, tpl: 'plastic', machine: '射出机 #2', inspector: '陈志明', shift: '中班', qty: 880 },
];

/** 示例异常单的处置状态：键是 DEMO_SPECS 的下标（0 起） */
const DEMO_ANOMALY_META = {
  5: { handler: '黄志强', handledHours: 2, closeHours: null, note: '换模后首件角度偏大，定位块松动' },
  10: {
    handler: '黄志强',
    handledHours: 1,
    closeHours: 3,
    closureNote: '调机后重新试模，熔接痕已消除；同批 1100 件全检后放行。',
  },
  12: { handler: '黄志强', handledHours: 4, closeHours: null, note: '焊锡温度偏低，已调整回流焊曲线' },
  18: { handler: '', handledHours: null, closeHours: null, note: '整批隔离在待判区，等电源板来料分析结果' },
};

function yymmdd(ts) {
  const d = new Date(ts);
  const y = `${d.getFullYear()}`.slice(2);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * 生成示例台账。
 * @returns {{ records: Array, anomalies: Array }}
 */
export function buildDemoHistory({ templates = [], now = Date.now() } = {}) {
  // 示例里用短名（metal / plastic / electronics）指模板，省得数据表里全是 tpl- 前缀
  const byId = {};
  for (const t of templates) byId[t.id.replace(/^tpl-/, '')] = t;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const base = startOfToday.getTime();
  const dayCounter = new Map();

  const records = [];
  const anomalies = [];

  DEMO_SPECS.forEach((spec, idx) => {
    const template = byId[spec.tpl];
    if (!template) return;
    const createdAt = base + spec.d * 86400000 + Math.round(spec.h * 3600000) + 12 * 60000;
    const day = yymmdd(createdAt);
    const n = (dayCounter.get(day) || 0) + 1;
    dayCounter.set(day, n);
    const seq = String(n).padStart(2, '0');

    const values = passingValues(template);
    for (const [itemName, v] of Object.entries(spec.fail || {})) {
      const item = template.items.find((i) => i.name === itemName);
      if (!item) throw new Error(`示例数据引用了模板里不存在的检查项：${itemName}`);
      values[item.id] = v;
    }

    const judged = judgeRecord(template, values);
    const record = {
      id: `demo-r-${String(idx + 1).padStart(2, '0')}`,
      createdAt,
      updatedAt: createdAt,
      workOrder: `MO-${day}-${seq}`,
      batchNo: `B-${day}-${seq}`,
      machine: spec.machine,
      inspector: spec.inspector,
      shift: spec.shift,
      qty: spec.qty,
      templateId: template.id,
      templateName: template.name,
      results: judged.results,
      counted: judged.counted,
      failedCount: judged.failed.length,
      verdict: judged.verdict,
      note: spec.note || '',
      photos: [],
      anomalyId: '',
      anomalyLevel: '',
      demo: true,
    };

    if (judged.verdict === 'fail') {
      const meta = DEMO_ANOMALY_META[idx] || {};
      const a = buildAnomaly(record, judged.failed, {
        reason: meta.note || undefined,
        handler: meta.handler || '',
        handledAt: meta.handledHours ? createdAt + meta.handledHours * 3600000 : null,
      });
      a.id = `demo-a-${String(anomalies.length + 1).padStart(2, '0')}`;
      a.createdAt = createdAt;
      if (meta.closeHours) {
        const closed = closeAnomaly(a, {
          closedAt: createdAt + meta.closeHours * 3600000,
          closureNote: meta.closureNote,
          handler: meta.handler,
        });
        Object.assign(a, closed);
      }
      record.anomalyId = a.id;
      record.anomalyLevel = a.level;
      anomalies.push(a);
    }

    records.push(record);
  });

  return { records, anomalies };
}

