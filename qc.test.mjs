/**
 * 车间质检本 · 领域逻辑测试
 * 重点：判定、异常分级、追溯查询、报表统计。
 * 这几块出错的方式都很安静（漏检、级别报错、查不到），所以用断言把它们钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  normalizeTemplates,
  templateStats,
  judgeItem,
  judgeRecord,
  overRatio,
  suggestLevel,
  buildAnomaly,
  closeAnomaly,
  queryRecords,
  summarizeRecord,
  buildReport,
  resolveWindow,
  toCsv,
  recordsToCsv,
  recordsToLongCsv,
  anomaliesToCsv,
  reportToMarkdown,
  classifyComplaint,
  buildDemoHistory,
  passingValues,
  nominalValue,
  specText,
  dayKey,
  displayValue,
  formatDateTime,
} from './qc.js';

const rawTemplates = JSON.parse(readFileSync(new URL('./templates.json', import.meta.url), 'utf8')).templates;
const templates = normalizeTemplates(rawTemplates);
const tpl = (id) => templates.find((t) => t.id === id);
const item = (tplId, name) => tpl(tplId).items.find((i) => i.name === name);

/** 固定「现在」，让所有与日期有关的断言可复现 */
const NOW = new Date(2026, 9, 18, 17, 0, 0).getTime();

/* ==========================================================================
   模板
   ========================================================================== */

test('normalizeTemplates: 三套内置模板都能读出来，检查项 id 唯一', () => {
  assert.equal(templates.length, 3);
  assert.deepEqual(
    templates.map((t) => t.id),
    ['tpl-metal', 'tpl-plastic', 'tpl-electronics'],
  );
  const ids = templates.flatMap((t) => t.items.map((i) => i.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(templates.every((t) => t.builtin === true));
});

test('normalizeTemplates: 不合法的字段被改正，不留给界面去处理', () => {
  const [t] = normalizeTemplates([
    {
      name: '临时模板',
      items: [{ name: '厚度', type: '瞎写', min: 1, max: 2 }, { name: '长度', type: 'number' }],
    },
  ]);
  assert.equal(t.id, 'tpl-1');
  assert.equal(t.items[0].type, 'number', '未知类型要退回数值型');
  assert.equal(t.items[1].severity, 'major', '数值项默认主要');
  assert.equal(t.items[1].required, true, '默认必填');
  const [t2] = normalizeTemplates([{ name: 'x', items: [{ name: '外观', type: 'text' }] }]);
  assert.equal(t2.items[0].severity, 'minor', '文字项默认次要');
});

test('templateStats: 统计必填与关键项数量', () => {
  const s = templateStats(tpl('tpl-metal'));
  assert.equal(s.total, 8);
  assert.equal(s.required, 7, '「外观描述」不是必填');
  assert.equal(s.critical, 1, '只有「外径」是关键项');
});

test('specText / nominalValue: 规格写法与标准值', () => {
  assert.equal(specText(item('tpl-metal', '外径')), '9.8 – 10.2 mm');
  assert.equal(specText(item('tpl-metal', '毛刺高度')), '≤ 0.05 mm');
  assert.equal(specText(item('tpl-metal', '冲压面划痕')), '要求：无');
  assert.equal(specText(item('tpl-plastic', '熔接痕')), '可接受：无 / 轻微');
  assert.equal(nominalValue(item('tpl-metal', '外径')), 10, '(9.8+10.2)/2');
  assert.equal(nominalValue(item('tpl-metal', '毛刺高度')), 0.04, '只有上限时取 80%');
  assert.equal(nominalValue(item('tpl-metal', '冲压面划痕')), false, '要求「无」时标准值就是 false');
  assert.equal(nominalValue(item('tpl-plastic', '熔接痕')), '无');
});

/* ==========================================================================
   上下限判定
   ========================================================================== */

test('judgeItem: 数值落在上下限内判合格，并说明规格', () => {
  const it = item('tpl-metal', '外径');
  const r = judgeItem(it, '10.05');
  assert.equal(r.status, 'pass');
  assert.match(r.reason, /9\.8 – 10\.2 mm/);
});

test('judgeItem: 等于上下限算合格（够到就算数）', () => {
  const it = item('tpl-metal', '外径');
  assert.equal(judgeItem(it, 9.8).status, 'pass');
  assert.equal(judgeItem(it, 10.2).status, 'pass');
  assert.equal(judgeItem(it, 9.799).status, 'fail');
  assert.equal(judgeItem(it, 10.201).status, 'fail');
});

test('judgeItem: 低于下限 / 高于上限都判不合格，方向写清楚', () => {
  const it = item('tpl-metal', '外径');
  const low = judgeItem(it, '9.5');
  assert.equal(low.status, 'fail');
  assert.equal(low.label, '偏低');
  assert.match(low.reason, /低于下限 9\.8 mm/);
  const high = judgeItem(it, '10.6');
  assert.equal(high.status, 'fail');
  assert.equal(high.label, '偏高');
  assert.match(high.reason, /高于上限 10\.2 mm/);
});

test('judgeItem: 单边规格（只有上限）也能判', () => {
  const it = item('tpl-electronics', '空载电流');
  assert.equal(specText(it), '≤ 80 mA');
  assert.equal(judgeItem(it, 72).status, 'pass');
  assert.equal(judgeItem(it, 80).status, 'pass');
  assert.equal(judgeItem(it, 81).status, 'fail');
  assert.equal(judgeItem(it, -5).status, 'pass', '只有上限时不看下限');
});

test('judgeItem: 空白是「未填」，乱写是「填错」，两者都不能算合格', () => {
  const it = item('tpl-metal', '外径');
  assert.equal(judgeItem(it, '').status, 'empty');
  assert.equal(judgeItem(it, null).status, 'empty');
  const bad = judgeItem(it, '十个');
  assert.equal(bad.status, 'invalid');
  assert.match(bad.reason, /不是数字/);
});

test('judgeItem: 千分位逗号与全角空格不影响读数', () => {
  const it = { id: 'x', name: '批量电流', type: 'number', min: 0, max: 2000 };
  assert.equal(judgeItem(it, ' 1,250 ').status, 'pass');
  assert.equal(judgeItem(it, ' 1,250 ').value, ' 1,250 ');
});

test('judgeItem: 是/否项按「合格答案」判，不按真假判', () => {
  const no = item('tpl-metal', '冲压面划痕'); // expect: no
  assert.equal(judgeItem(no, false).status, 'pass');
  assert.equal(judgeItem(no, true).status, 'fail');
  assert.match(judgeItem(no, true).reason, /要求是「否」/);
  const yes = item('tpl-electronics', '通电亮灯'); // expect: yes
  assert.equal(judgeItem(yes, true).status, 'pass');
  assert.equal(judgeItem(yes, false).status, 'fail');
});

test('judgeItem: 没点是/否 = 没填，不能当成「否」判不合格', () => {
  const yes = item('tpl-electronics', '通电亮灯'); // 合格答案是「是」
  assert.equal(judgeItem(yes, undefined).status, 'empty');
  assert.equal(judgeItem(yes, null).status, 'empty');
  assert.equal(judgeItem(yes, '').status, 'empty');
  assert.notEqual(judgeItem(yes, undefined).status, 'fail');
  // 没填必填项 → 整张记录「未完成」，不是「不合格」
  const template = tpl('tpl-electronics');
  const values = passingValues(template);
  values[yes.id] = undefined;
  const r = judgeRecord(template, values);
  assert.equal(r.verdict, 'incomplete');
  assert.deepEqual(r.missing.map((m) => m.name), ['通电亮灯']);
  assert.equal(r.failed.length, 0);
});

test('judgeItem: 选项项只接受可接受选项，选项外判不合格', () => {
  const it = item('tpl-electronics', '焊接质量');
  assert.equal(judgeItem(it, '良好').status, 'pass');
  assert.equal(judgeItem(it, ' 良好 ').status, 'pass', '空格要归一');
  const bad = judgeItem(it, '虚焊');
  assert.equal(bad.status, 'fail');
  assert.match(bad.reason, /不在可接受范围/);
  const mild = item('tpl-plastic', '熔接痕');
  assert.equal(judgeItem(mild, '轻微').status, 'pass');
  assert.equal(judgeItem(mild, '明显').status, 'fail');
});

test('judgeItem: 文字项系统不替人下结论', () => {
  const it = item('tpl-metal', '外观描述');
  const r = judgeItem(it, '左下角轻微碰伤 2 件');
  assert.equal(r.status, 'pass');
  assert.match(r.reason, /需人工判读/);
});

test('overRatio: 偏离规格带的比例算得对（分级靠它）', () => {
  const it = item('tpl-metal', '折弯角度'); // 89 – 91，带宽 2
  assert.equal(overRatio(it, 91), 0);
  assert.equal(overRatio(it, 90.5), 0);
  assert.equal(overRatio(it, 91.8), 0.4);
  assert.equal(overRatio(it, 92.6), 0.8);
  assert.equal(overRatio(it, 87), 1, '低于下限 2 度 = 一个完整带宽');
  assert.equal(overRatio({ min: null, max: 0.05 }, 0.11), 1.2, '单边规格用上限本身当参照');
  // 上下限相等（只给标准值）时不能除零
  assert.ok(Number.isFinite(overRatio({ min: 5, max: 5 }, 5.4)));
});

test('judgeRecord: 一项不合格整批就不合格，并把缺失项列出来', () => {
  const template = tpl('tpl-metal');
  const values = passingValues(template);
  assert.equal(judgeRecord(template, values).verdict, 'pass');

  const bad = { ...values, [item('tpl-metal', '孔径').id]: 5.3 };
  const r = judgeRecord(template, bad);
  assert.equal(r.verdict, 'fail');
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].name, '孔径');
  assert.equal(r.counted, 8);

  const incomplete = { ...values };
  delete incomplete[item('tpl-metal', '料厚').id];
  const r2 = judgeRecord(template, incomplete);
  assert.equal(r2.verdict, 'incomplete', '必填项没填不能算合格');
  assert.deepEqual(r2.missing.map((m) => m.name), ['料厚']);
});

test('judgeRecord: 记录里保存当时的规格（模板以后改了也不影响旧记录）', () => {
  const r = judgeRecord(tpl('tpl-metal'), passingValues(tpl('tpl-metal')));
  const row = r.results.find((x) => x.name === '外径');
  assert.equal(row.min, 9.8);
  assert.equal(row.max, 10.2);
  assert.equal(row.unit, 'mm');
  assert.equal(row.limit, '9.8 – 10.2 mm');
  assert.equal(row.type, 'number');
  assert.equal(row.frequency, '首件');
});

/* ==========================================================================
   异常分级
   ========================================================================== */

const pair = (tplId, name, value) => {
  const it = item(tplId, name);
  return judgeItem(it, value);
};

test('suggestLevel: 没有超限项就不开单', () => {
  assert.equal(suggestLevel([]).level, null);
  assert.equal(suggestLevel([judgeItem(item('tpl-metal', '外径'), 10)]).level, null);
});

test('suggestLevel: 关键项不合格 → 报废', () => {
  const s = suggestLevel([pair('tpl-electronics', '通电亮灯', false)]);
  assert.equal(s.level, 'scrap');
  assert.match(s.reason, /关键项/);
});

test('suggestLevel: 主要项超限 → 隔离；偏差过半 → 报废', () => {
  const s = suggestLevel([pair('tpl-metal', '折弯角度', 91.8)]); // 偏离 40%
  assert.equal(s.level, 'isolate');
  const s2 = suggestLevel([pair('tpl-metal', '折弯角度', 92.6)]); // 偏离 80%
  assert.equal(s2.level, 'scrap');
  assert.match(s2.reason, /80%/);
});

test('suggestLevel: 次要项不合格 → 返工（外观问题不该判报废）', () => {
  assert.equal(suggestLevel([pair('tpl-plastic', '熔接痕', '明显')]).level, 'rework');
  assert.equal(suggestLevel([pair('tpl-metal', '毛刺高度', 0.11)]).level, 'rework');
  assert.equal(suggestLevel([pair('tpl-metal', '冲压面划痕', true)]).level, 'rework');
});

test('suggestLevel: 关键项与次要项同时不合格时，按关键项走', () => {
  const s = suggestLevel([
    pair('tpl-electronics', '异响', true),
    pair('tpl-electronics', '通电亮灯', false),
  ]);
  assert.equal(s.level, 'scrap');
  assert.equal(s.hits[0].name, '通电亮灯');
});

test('suggestLevel: 永远不会自动选「让步接收」', () => {
  for (const lv of ['metal', 'plastic', 'electronics']) {
    for (const it of tpl(`tpl-${lv}`).items) {
      const r = judgeItem(it, it.type === 'bool' ? !item(`tpl-${lv}`, it.name).expect : 99999);
      const s = suggestLevel([r]);
      assert.notEqual(s.level, 'concession', `让步接收只能是人工决定：${it.name}`);
    }
  }
});

test('buildAnomaly: 等级沿用建议值，并带齐批号与不良项', () => {
  const template = tpl('tpl-plastic');
  const values = { ...passingValues(template), [item('tpl-plastic', '射出件重量').id]: 12.98 };
  const judged = judgeRecord(template, values);
  const record = { id: 'r-1', batchNo: 'B-261018-01', workOrder: 'MO-261018-01', machine: '射出机 #1', inspector: '陈志明' };
  const a = buildAnomaly(record, judged.failed);
  assert.equal(a.level, 'isolate');
  assert.equal(a.suggestedLevel, 'isolate');
  assert.equal(a.batchNo, 'B-261018-01');
  assert.equal(a.machine, '射出机 #1');
  assert.equal(a.failedItems.length, 1);
  assert.equal(a.failedItems[0].name, '射出件重量');
  assert.equal(a.closed, false);
  assert.equal(a.handler, '');
});

test('buildAnomaly: 让步接收必须填核准人，否则拒绝建单', () => {
  const template = tpl('tpl-plastic');
  const judged = judgeRecord(template, { ...passingValues(template), [item('tpl-plastic', '熔接痕').id]: '明显' });
  const record = { id: 'r-2', batchNo: 'B-1', workOrder: 'MO-1', machine: 'M', inspector: 'I' };
  assert.throws(() => buildAnomaly(record, judged.failed, { level: 'concession' }), /核准人/);
  const ok = buildAnomaly(record, judged.failed, { level: 'concession', approvedBy: '黄志强', reason: '客户书面同意' });
  assert.equal(ok.level, 'concession');
  assert.equal(ok.approvedBy, '黄志强');
});

test('closeAnomaly: 关闭必须写处理结果，写清楚了才盖上时间', () => {
  const template = tpl('tpl-plastic');
  const judged = judgeRecord(template, { ...passingValues(template), [item('tpl-plastic', '熔接痕').id]: '明显' });
  const a = buildAnomaly({ id: 'r-3', batchNo: 'B-2', workOrder: 'MO-2', machine: 'M', inspector: 'I' }, judged.failed);
  assert.throws(() => closeAnomaly(a, { closureNote: '   ' }), /处理结果/);
  const closed = closeAnomaly(a, { closureNote: '调机后重检合格，已放行', closedAt: a.createdAt + 3600000 });
  assert.equal(closed.closed, true);
  assert.equal(closed.closedAt - closed.createdAt, 3600000);
  assert.equal(closed.handler, '', '没人处置时不能凭空造一个');
});

test('buildAnomaly: 是/否项在异常单上写「是」「否」，原始值另存', () => {
  const template = tpl('tpl-electronics');
  const judged = judgeRecord(template, { ...passingValues(template), [item('tpl-electronics', '通电亮灯').id]: false });
  const a = buildAnomaly({ id: 'r-4', batchNo: 'B-4', workOrder: 'MO-4', machine: 'M', inspector: 'I' }, judged.failed);
  assert.equal(a.failedItems[0].value, '否', '单子给人看，不能印 false');
  assert.equal(a.failedItems[0].rawValue, false, '原始值留着给数据用');
});

/* ==========================================================================
   追溯查询
   ========================================================================== */

const demo = buildDemoHistory({ templates, now: NOW });

test('buildDemoHistory: 生成固定的 20 笔台账、4 张异常单（可复现）', () => {
  assert.equal(demo.records.length, 20);
  assert.equal(demo.anomalies.length, 4);
  const again = buildDemoHistory({ templates, now: NOW });
  assert.deepEqual(
    again.records.map((r) => [r.id, r.createdAt, r.verdict, r.batchNo]),
    demo.records.map((r) => [r.id, r.createdAt, r.verdict, r.batchNo]),
  );
  assert.equal(demo.records.filter((r) => r.verdict === 'fail').length, 4);
  assert.deepEqual(demo.anomalies.map((a) => a.level), ['isolate', 'rework', 'isolate', 'scrap']);
  assert.deepEqual(demo.anomalies.map((a) => a.closed), [false, true, false, false]);
});

test('queryRecords: 按批号查得到，查不到就是空', () => {
  const target = demo.records[4];
  const hit = queryRecords(demo.records, { batchNo: target.batchNo });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].id, target.id);
  assert.equal(queryRecords(demo.records, { batchNo: 'B-不存在' }).length, 0);
});

test('queryRecords: 按工单 / 机台 / 检验员任一条件都能查', () => {
  assert.equal(queryRecords(demo.records, { workOrder: 'MO-261013-03' }).length, 1);
  assert.equal(queryRecords(demo.records, { workOrder: 'MO-261013' }).length, 4, '工单支持前缀模糊');
  const machine = queryRecords(demo.records, { machine: '射出机 #2' });
  assert.equal(machine.length, 4);
  assert.ok(machine.every((r) => r.machine === '射出机 #2'));
  const person = queryRecords(demo.records, { inspector: '王建国' });
  assert.equal(person.length, 6);
  assert.ok(person.every((r) => r.inspector === '王建国'));
});

test('queryRecords: 按时间窗查，边界含头含尾', () => {
  const lo = demo.records[3].createdAt;
  const hi = demo.records[6].createdAt;
  const hit = queryRecords(demo.records, { from: lo, to: hi });
  assert.equal(hit.length, 4);
  assert.ok(hit.every((r) => r.createdAt >= lo && r.createdAt <= hi));
});

test('queryRecords: 按结论筛 + 多条件叠加', () => {
  assert.equal(queryRecords(demo.records, { verdict: 'fail' }).length, 4);
  const combo = queryRecords(demo.records, { inspector: '王建国', verdict: 'fail' });
  assert.equal(combo.length, 2);
  assert.ok(combo.every((r) => r.inspector === '王建国' && r.verdict === 'fail'));
  assert.equal(queryRecords(demo.records, { machine: '射出机 #1', verdict: 'fail' }).length, 1);
});

test('queryRecords: 关键字能命中检查项名与实测值（客诉场景：只知道不良现象）', () => {
  const byItem = queryRecords(demo.records, { keyword: '熔接痕' });
  assert.equal(byItem.length, 1, '只捞「熔接痕出过问题」的那一批，不是整个塑胶模板的所有记录');
  assert.equal(byItem[0].verdict, 'fail');
  const byValue = queryRecords(demo.records, { keyword: '91.8' });
  assert.equal(byValue.length, 1);
  assert.ok(byValue[0].results.some((x) => String(x.value) === '91.8'));
  const byReason = queryRecords(demo.records, { keyword: '高于上限' });
  assert.equal(byReason.length, 1);
  const byTemplate = queryRecords(demo.records, { keyword: '电子组装' });
  assert.equal(byTemplate.length, 6);
});

test('queryRecords: 传入异常单后，异常的处理经过与处置人也搜得到', () => {
  const anomalyMap = Object.fromEntries(demo.anomalies.map((a) => [a.id, a]));
  assert.equal(queryRecords(demo.records, { keyword: '定位块' }).length, 0, '异常单里的字，不传就不该瞎猜');
  const byAnomaly = queryRecords(demo.records, { keyword: '定位块' }, { anomalyMap });
  assert.equal(byAnomaly.length, 1);
  assert.equal(byAnomaly[0].verdict, 'fail');
  const byHandler = queryRecords(demo.records, { keyword: '黄志强' }, { anomalyMap });
  assert.equal(byHandler.length, 3, '三张异常单是黄志强处置的');
  const byClosure = queryRecords(demo.records, { keyword: '全检后放行' }, { anomalyMap });
  assert.equal(byClosure.length, 1);
});

test('queryRecords: 按异常等级筛，结果按时间倒序', () => {
  const scrap = queryRecords(demo.records, { level: 'scrap' });
  assert.equal(scrap.length, 1);
  assert.equal(scrap[0].anomalyLevel, 'scrap');
  const all = queryRecords(demo.records, {});
  assert.equal(all.length, 20);
  for (let i = 1; i < all.length; i += 1) {
    assert.ok(all[i - 1].createdAt >= all[i].createdAt, '时间新的要排在前面');
  }
});

test('summarizeRecord: 一行摘要带齐照片数、不良项、异常等级', () => {
  const fail = demo.records.find((r) => r.verdict === 'fail');
  const s = summarizeRecord(fail);
  assert.equal(s.verdictLabel, '不合格');
  assert.equal(s.failedCount, 1);
  assert.deepEqual(s.failedNames, ['折弯角度']);
  assert.equal(s.photoCount, 0);
  assert.equal(s.anomalyLevelLabel, '隔离');
  assert.equal(s.when, formatDateTime(fail.createdAt));
});

/* ==========================================================================
   报表
   ========================================================================== */

test('resolveWindow: 日报只算当天，周报算近 7 天', () => {
  const day = resolveWindow('day', NOW);
  assert.equal(day.days, 1);
  assert.equal(dayKey(day.from), '2026-10-18');
  const week = resolveWindow('week', NOW);
  assert.equal(week.days, 7);
  assert.equal(dayKey(week.from), '2026-10-12');
  assert.equal(week.to, NOW);
});

test('buildReport: 周报数字与示例台账对得上', () => {
  const rep = buildReport({ records: demo.records, anomalies: demo.anomalies, granularity: 'week', now: NOW });
  assert.equal(rep.batches, 20);
  assert.equal(rep.failBatches, 4);
  assert.equal(rep.passBatches, 16);
  assert.equal(rep.defectBatchRate, 0.2);
  assert.equal(rep.checkedItems, 166, '20 笔的已判定检查项合计');
  assert.equal(rep.failedItems, 5, '其中 1 笔同时坏了 2 项');
  assert.equal(rep.defectItemRate, 0.0301);
  assert.equal(rep.openCount, 3);
  assert.equal(rep.avgCloseHours, 3);
  assert.equal(rep.label, '周报 · 近 7 天');
});

test('buildReport: 分日趋势 7 根柱子，数量对得上', () => {
  const rep = buildReport({ records: demo.records, anomalies: demo.anomalies, granularity: 'week', now: NOW });
  assert.equal(rep.byDay.length, 7);
  assert.deepEqual(
    rep.byDay.map((d) => d.batches),
    [3, 4, 3, 4, 3, 3, 0],
  );
  assert.deepEqual(
    rep.byDay.map((d) => d.fail),
    [0, 1, 0, 2, 0, 1, 0],
  );
  assert.equal(rep.byDay[6].label, '10-18');
});

test('buildReport: Top 不良项与分级分布', () => {
  const rep = buildReport({ records: demo.records, anomalies: demo.anomalies, granularity: 'week', now: NOW });
  assert.equal(rep.topDefects.length, 5);
  assert.ok(rep.topDefects.every((d) => d.count === 1));
  assert.deepEqual(rep.topDefects.map((d) => d.name).sort(), ['异响', '折弯角度', '焊接质量', '熔接痕', '通电亮灯']);
  assert.deepEqual(rep.levels, { scrap: 1, isolate: 2, rework: 1, concession: 0 });
});

test('buildReport: 按检验员统计批次与不良', () => {
  const rep = buildReport({ records: demo.records, anomalies: demo.anomalies, granularity: 'week', now: NOW });
  const chen = rep.inspectors.find((i) => i.name === '陈志明');
  assert.equal(chen.batches, 8);
  assert.equal(chen.fail, 1);
  assert.ok(rep.inspectors.every((i) => i.batches > 0));
  assert.equal(
    rep.inspectors.reduce((s, i) => s + i.batches, 0),
    20,
    '按人分的批次数加起来要等于总批次',
  );
});

test('buildReport: 当天没有记录时是干净的 0，不是 NaN', () => {
  const rep = buildReport({ records: demo.records, anomalies: demo.anomalies, granularity: 'day', now: NOW });
  assert.equal(rep.batches, 0);
  assert.equal(rep.defectBatchRate, 0);
  assert.equal(rep.defectItemRate, 0);
  assert.equal(rep.topDefects.length, 0);
  assert.equal(rep.avgCloseHours, null);
  assert.equal(rep.openCount, 3, '未关闭异常单是累计的，不受报表区间影响');
});

test('buildReport: 上一区间的不良率能算出来（周报要对比）', () => {
  const rep = buildReport({ records: demo.records, anomalies: [], granularity: 'week', now: NOW });
  assert.equal(rep.prevBatches, 0);
  assert.equal(rep.prevDefectBatchRate, 0);
  const later = buildReport({
    records: demo.records,
    anomalies: [],
    granularity: 'week',
    now: NOW + 7 * 86400000,
  });
  assert.equal(later.batches, 0);
  assert.equal(later.prevBatches, 20);
  assert.equal(later.prevDefectBatchRate, 0.2);
});

/* ==========================================================================
   导出
   ========================================================================== */

test('toCsv: 带 BOM、逗号引号换行都正确转义', () => {
  const csv = toCsv([{ a: '有,逗号', b: '他说"好"' }, { a: '换\n行', b: 1 }], [
    { label: '甲', get: (r) => r.a },
    { label: '乙', get: (r) => r.b },
  ]);
  assert.ok(csv.startsWith('\uFEFF'), '开头要有 BOM，Excel 才不乱码');
  assert.ok(csv.includes('"有,逗号"'));
  assert.ok(csv.includes('"他说""好"""'));
  assert.ok(csv.includes('"换\n行"'));
  assert.ok(csv.includes('\r\n'), '用 CRLF，Windows 上才规矩');
});

test('recordsToCsv / recordsToLongCsv / anomaliesToCsv: 行数与表头正确', () => {
  const wide = recordsToCsv(demo.records.slice(0, 3));
  const lines = wide.trim().split('\r\n');
  assert.equal(lines.length, 4, '1 行表头 + 3 行数据');
  assert.ok(lines[0].includes('批号'));

  const long = recordsToLongCsv(demo.records.slice(0, 1));
  assert.equal(long.trim().split('\r\n').length, 9, '1 行表头 + 8 个检查项');

  const anom = anomaliesToCsv(demo.anomalies);
  assert.equal(anom.trim().split('\r\n').length, 5);
  assert.ok(anom.includes('隔离'), '等级要输出中文，交上去给主管看');
  assert.ok(anom.includes('报废'));
  assert.ok(anom.includes('调机后重新试模'), '已关闭的要带处理结果');
});

test('displayValue: CSV 里是/否写中文，没填写「—」，别让主管看到 false', () => {
  assert.equal(displayValue(true, 'bool'), '是');
  assert.equal(displayValue(false, 'bool'), '否');
  assert.equal(displayValue(undefined, 'bool'), '—');
  assert.equal(displayValue('', 'number'), '—');
  assert.equal(displayValue(null, 'number'), '—');
  assert.equal(displayValue(10.62, 'number'), 10.62);
  assert.equal(displayValue('电镀', 'option'), '电镀');

  const fail = demo.records.find((r) => r.verdict === 'fail' && r.results.some((x) => x.type === 'bool'));
  if (fail) {
    const csv = recordsToCsv([fail]);
    assert.ok(!csv.includes('false'), 'CSV 里不该出现 false');
  }
  const elec = demo.records.find((r) => r.verdict === 'fail' && r.anomalyLevel === 'scrap');
  const csv2 = recordsToCsv([elec]);
  assert.ok(csv2.includes('否'), '通电亮灯不合格，实测值要写「否」');
  assert.ok(csv2.includes('是'), '异响不合格，实测值要写「是」');
});

test('reportToMarkdown: 报表能贴进群里，关键数字都在', () => {
  const rep = buildReport({ records: demo.records, anomalies: demo.anomalies, granularity: 'week', now: NOW });
  const md = reportToMarkdown(rep, { records: demo.records, anomalies: demo.anomalies });
  assert.match(md, /^# 质检周报/);
  assert.ok(md.includes('| 检验批次 | 20 | 0 |'));
  assert.ok(md.includes('20.0%'), '不良率');
  assert.ok(md.includes('折弯角度'));
  assert.ok(md.includes('未关闭异常单'));
  assert.ok(md.includes('黄志强'));
});

/* ==========================================================================
   可选：投诉归类（纯离线规则）
   ========================================================================== */

test('classifyComplaint: 投诉里出现检查项名就贴到那一项', () => {
  const r = classifyComplaint('客户反馈这批卡扣间距偏大，装不进外壳', tpl('tpl-plastic').items);
  assert.equal(r.matches[0].name, '卡扣间距');
  assert.ok(r.confidence >= 0.6);
});

test('classifyComplaint: 没有检查项名时，按不良现象词表归类', () => {
  const r = classifyComplaint('客户说外壳有刮伤，还有油污', tpl('tpl-plastic').items);
  assert.equal(r.category, '外观描述', '词表命中「刮伤」，落到外观这一项');
  assert.equal(r.confidence, 0.45, '词表归类要给一个「不太确定」的置信度');
  const w = classifyComplaint('这批货有虚焊', tpl('tpl-electronics').items);
  assert.equal(w.matches[0].name, '焊接质量');
});

test('classifyComplaint: 完全不相关的话不硬猜', () => {
  const r = classifyComplaint('你们发货太慢了', tpl('tpl-plastic').items);
  assert.equal(r.matches.length, 0);
  assert.equal(r.confidence, 0);
  assert.equal(classifyComplaint('', tpl('tpl-plastic').items).matches.length, 0);
});
