'use strict';
// 仓管批号计量：端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务实例（含演示数据），验证：
//   期初：非负整数克，每批号一次（重复 409），非法数量 400，登记即启用计量；
//   入库：唯一单号正整数克，流水只增不改；单号重复/未启用批号/非正整数均拒绝且无部分流水；
//   投料：启用批号每笔必填正整数克、未启用批号/批号未知禁填克数；
//         累计领用 <= 期初+入库，超额 409 整次回滚（原事件、库存不变）；
//   旧输入：启用前的 NULL 数量输入保留且不计领用，更正时必须补量；
//   删除/更正：同一事务按最终事件集重算领用，余额不足整次拒绝；
//   断网补录：同内容重试 / 复用既有外部记录号不重复领用；
//   换线预演：只展示各批号余额差异不占库存；超额预演 409、确认应用原子重算；
//   查询：余额接口与 /api/state 显示期初/入库/领用/可用量/未计量旧输入数。
//   node scripts/test-stock.js   退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39151';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-test-'));
const dbPath = path.join(tmpDir, 'test.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

async function api(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(proc) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/api/state');
      if (res.ok) return;
    } catch (_) { /* 未就绪 */ }
    if (proc.exitCode !== null) throw new Error('服务提前退出');
    await sleep(250);
  }
  throw new Error('服务启动超时');
}

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', DB_PATH: dbPath, SEED_DEMO: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitReady(proc);
    console.log('服务已就绪，开始测试');

    const st = (await api('GET', '/api/state')).json;
    const matId = (code) => st.materials.find((m) => m.code === code).id;
    const lotId = (matCode, lotCode) =>
      st.materials.find((m) => m.code === matCode).lots.find((l) => l.lot_code === lotCode).id;

    // 用全新原料 + 批号做干净的计量测试，避免演示数据干扰。
    const M = (await api('POST', '/api/materials', { code: 'OAT-01', name: '燕麦粉', allergens: [] })).json.id;
    const L = (await api('POST', '/api/material-lots', { material_id: M, lot_code: 'OAT-L1', supplier: 'S' })).json.id;
    const EQUIP = st.equipment[0].id;
    const ev = (time, batch, qty) => ({
      event_time: time, type: 'PROCESS', equipment_id: EQUIP, batch_code: batch,
      material_inputs: [{ material_id: M, lot_id: L, qty_grams: qty }], ref_batch_ids: []
    });

    // ---- 未启用：余额 measured=false、available=null ----
    let b = (await api('GET', `/api/material-lots/${L}/balance`)).json;
    check('未启用批号 measured=false', b.measured === false);
    check('未启用批号 available_grams=null', b.available_grams === null);

    // ---- 入库必须先启用（未登记期初）----
    let r = await api('POST', `/api/material-lots/${L}/inbound`,
      { receipt_no: 'GR-1', qty_grams: 10, received_at: '2026-10-04T09:00' });
    check('未启用批号入库 -> 400 LOT_NOT_MEASURED', r.status === 400 && r.json.code === 'LOT_NOT_MEASURED', r.json);

    // ---- 非法期初 ----
    for (const bad of [-1, 1.5, 'abc', -0.1]) {
      r = await api('POST', `/api/material-lots/${L}/opening-balance`, { qty_grams: bad });
      check(`非法期初 ${JSON.stringify(bad)} -> 400`, r.status === 400, r.json);
    }

    // ---- 期初 100（含 0 边界另开一批号验证）----
    r = await api('POST', `/api/material-lots/${L}/opening-balance`,
      { qty_grams: 100, registered_by: '仓管' });
    check('期初 100 克登记成功', r.status === 200 && r.json.measured && r.json.opening_grams === 100, r.json);
    check('期初后可用量=100', r.json.available_grams === 100);

    // 0 克期初允许
    const L0 = (await api('POST', '/api/material-lots', { material_id: M, lot_code: 'OAT-L0' })).json.id;
    r = await api('POST', `/api/material-lots/${L0}/opening-balance`, { qty_grams: 0 });
    check('期初 0 克允许（非负整数）', r.status === 200 && r.json.opening_grams === 0, r.json);

    // 重复期初 409
    r = await api('POST', `/api/material-lots/${L}/opening-balance`, { qty_grams: 200 });
    check('重复期初 -> 409 OPENING_ALREADY_EXISTS',
      r.status === 409 && r.json.code === 'OPENING_ALREADY_EXISTS', r.json);
    b = (await api('GET', `/api/material-lots/${L}/balance`)).json;
    check('重复期初不覆盖（仍 100）', b.opening_grams === 100);

    // ---- 入库非法值 ----
    for (const bad of [0, -5, 2.5, 'x']) {
      r = await api('POST', `/api/material-lots/${L}/inbound`,
        { receipt_no: `BAD-${bad}`, qty_grams: bad, received_at: '2026-10-04T09:00' });
      check(`非法入库 ${JSON.stringify(bad)} -> 400`, r.status === 400, r.json);
    }
    // 入库 50
    r = await api('POST', `/api/material-lots/${L}/inbound`,
      { receipt_no: 'GR-001', qty_grams: 50, received_at: '2026-10-04T09:00', received_by: '仓管' });
    check('入库 50 克成功', r.status === 200 && r.json.qty_grams === 50, r.json);
    // 重复单号（不同批号）409，不产生流水
    r = await api('POST', `/api/material-lots/${L0}/inbound`,
      { receipt_no: 'GR-001', qty_grams: 10, received_at: '2026-10-04T09:05' });
    check('入库单号全局唯一 -> 409 RECEIPT_NO_CONFLICT',
      r.status === 409 && r.json.code === 'RECEIPT_NO_CONFLICT', r.json);
    b = (await api('GET', `/api/material-lots/${L}/balance`)).json;
    check('入库后总量=期初100+入库50=150', b.opening_grams === 100 && b.inbound_grams === 50 && b.available_grams === 150, b);

    // ---- 投料计量规则 ----
    // 缺克数 400
    r = await api('POST', '/api/events',
      { event_time: '2026-10-05T08:00', type: 'PROCESS', equipment_id: EQUIP, batch_code: 'B-A',
        material_inputs: [{ material_id: M, lot_id: L }], ref_batch_ids: [] });
    check('启用批号投料缺克数 -> 400 QTY_REQUIRED', r.status === 400 && r.json.code === 'QTY_REQUIRED', r.json);
    // 非正克数 400
    r = await api('POST', '/api/events',
      { event_time: '2026-10-05T08:00', type: 'PROCESS', equipment_id: EQUIP, batch_code: 'B-A',
        material_inputs: [{ material_id: M, lot_id: L, qty_grams: 0 }], ref_batch_ids: [] });
    check('投料 0 克 -> 400', r.status === 400, r.json);

    // 未启用批号（演示库 WHEAT-A 未登记期初）填克数 400
    const WHEAT = matId('WHEAT-01');
    const WHEATL = lotId('WHEAT-01', 'SUP-WHEAT-20260920-7');
    r = await api('POST', '/api/events',
      { event_time: '2026-10-05T08:00', type: 'PROCESS', equipment_id: EQUIP, batch_code: 'B-W',
        material_inputs: [{ material_id: WHEAT, lot_id: WHEATL, qty_grams: 5 }], ref_batch_ids: [] });
    check('未启用批号填克数 -> 400 QTY_ON_UNMEASURED_LOT',
      r.status === 400 && r.json.code === 'QTY_ON_UNMEASURED_LOT', r.json);
    // 未启用批号不填克数 -> 沿用原规则 200
    r = await api('POST', '/api/events',
      { event_time: '2026-10-05T08:00', type: 'PROCESS', equipment_id: 2, batch_code: 'B-W',
        material_inputs: [{ material_id: WHEAT, lot_id: WHEATL }], ref_batch_ids: [] });
    check('未启用批号不填克数 -> 200（沿用原规则）', r.status === 200, r.json);

    // ---- 累计领用与超额回滚 ----
    r = await api('POST', '/api/events', ev('2026-10-05T09:00', 'B-U1', 140));
    check('领用 140（供150）成功', r.status === 200, r.json);
    b = (await api('GET', `/api/material-lots/${L}/balance`)).json;
    check('用后 used=140 available=10', b.used_grams === 140 && b.available_grams === 10, b);
    r = await api('POST', '/api/events', ev('2026-10-05T10:00', 'B-U2', 20));
    check('再领 20 超额 -> 409 INSUFFICIENT_STOCK',
      r.status === 409 && r.json.code === 'INSUFFICIENT_STOCK', r.json);
    b = (await api('GET', `/api/material-lots/${L}/balance`)).json;
    check('超额回滚后 used 仍 140、available 仍 10（原事件库存不变）',
      b.used_grams === 140 && b.available_grams === 10, b);

    // ---- 更正：减少用量释放余额；超额更正回滚 ----
    const u1id = r.json && r.json.details ? null : null; // 取上一成功事件 id
    const state1 = (await api('GET', '/api/state')).json;
    const u1 = state1.events.find((e) => e.batch_code === 'B-U1').id;
    r = await api('PUT', `/api/events/${u1}`, ev('2026-10-05T09:00', 'B-U1', 100));
    check('更正用量 140->100 成功', r.status === 200, r.json);
    b = (await api('GET', `/api/material-lots/${L}/balance`)).json;
    check('更正后 used=100 available=50', b.used_grams === 100 && b.available_grams === 50, b);
    r = await api('PUT', `/api/events/${u1}`, ev('2026-10-05T09:00', 'B-U1', 151));
    check('更正为 151 超额 -> 409 回滚', r.status === 409 && r.json.code === 'INSUFFICIENT_STOCK', r.json);
    b = (await api('GET', `/api/material-lots/${L}/balance`)).json;
    check('超额更正回滚后 used 仍 100', b.used_grams === 100, b);

    // ---- 断网补录：同内容重试 / 复用外部记录号不重复领用 ----
    const bfBody = {
      backfill_code: 'BF-OAT-1',
      records: [{
        external_ref: 'OAT-LOG-1', type: 'PROCESS', event_time: '2026-10-06T08:00',
        equipment_id: 2, batch_code: 'B-BF1',
        material_inputs: [{ material_id: M, lot_id: L, qty_grams: 30 }]
      }]
    };
    r = await api('POST', '/api/backfills', bfBody);
    check('补录领用 30 成功', r.status === 200, r.json);
    b = (await api('GET', `/api/material-lots/${L}/balance`)).json;
    check('补录后 used=130 available=20', b.used_grams === 130 && b.available_grams === 20, b);
    r = await api('POST', '/api/backfills', bfBody);
    check('同内容补录重试 idempotent', r.status === 200 && r.json.idempotent === true, r.json);
    b = (await api('GET', `/api/material-lots/${L}/balance`)).json;
    check('幂等重试不重复领用（used 仍 130）', b.used_grams === 130, b);
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-OAT-2',
      records: [bfBody.records[0]] // 跨包复用同一 external_ref + 同内容
    });
    check('跨包复用同号同内容 200 且 reused=1',
      r.status === 200 && r.json.impact_summary.reused_events === 1 &&
      r.json.impact_summary.inserted_events === 0, r.json);
    b = (await api('GET', `/api/material-lots/${L}/balance`)).json;
    check('复用既有外部记录号不重复领用（used 仍 130）', b.used_grams === 130, b);

    // ---- 换线预演：余额差异不占库存；超额 409 ----
    const bfEvt = (await api('GET', '/api/state')).json.events
      .find((e) => e.batch_code === 'B-BF1').id;
    const change = (qty) => ({
      op: 'update', event_id: bfEvt, type: 'PROCESS',
      event_time: '2026-10-06T08:00', equipment_id: 2, batch_code: 'B-BF1',
      material_inputs: [{ material_id: M, lot_id: L, qty_grams: qty }], ref_batch_ids: []
    });
    r = await api('POST', '/api/replan/preview', { changes: [change(10)] });
    check('预演减量 30->10 返回余额差异', r.status === 200 &&
      (r.json.diff.lot_balances || []).some((x) =>
        x.lot_id === L && x.before_used_grams === 130 && x.after_used_grams === 110), r.json);
    b = (await api('GET', `/api/material-lots/${L}/balance`)).json;
    check('预演不占库存（used 仍 130）', b.used_grams === 130, b);
    r = await api('POST', '/api/replan/preview', { changes: [change(999)] });
    check('预演超额 -> 409 INSUFFICIENT_STOCK',
      r.status === 409 && r.json.code === 'INSUFFICIENT_STOCK', r.json);
    // 合法预演 -> 确认应用，库存原子变化
    const pv = (await api('POST', '/api/replan/preview', { changes: [change(10)] })).json;
    r = await api('POST', '/api/replan/apply', { version: pv.version, changes: pv.changes });
    check('确认应用成功 200', r.status === 200, r.json);
    b = (await api('GET', `/api/material-lots/${L}/balance`)).json;
    check('确认后 used=110 available=40', b.used_grams === 110 && b.available_grams === 40, b);

    // ---- 未计量旧输入：启用前存在，启用后保留 NULL、不计领用，更正须补量 ----
    // 用一个全新批号：先在未启用状态投料（NULL），再启用计量。
    const L2 = (await api('POST', '/api/material-lots', { material_id: M, lot_code: 'OAT-L2' })).json.id;
    const old = await api('POST', '/api/events',
      { event_time: '2026-10-07T08:00', type: 'PROCESS', equipment_id: 2, batch_code: 'B-OLD',
        material_inputs: [{ material_id: M, lot_id: L2 }], ref_batch_ids: [] });
    check('未启用时投料成功（NULL 数量）', old.status === 200, old.json);
    await api('POST', `/api/material-lots/${L2}/opening-balance`, { qty_grams: 5 });
    b = (await api('GET', `/api/material-lots/${L2}/balance`)).json;
    check('启用后旧输入保留、未计量旧输入数=1、不计领用（used=0,available=5）',
      b.unmeasured_input_count === 1 && b.used_grams === 0 && b.available_grams === 5, b);
    const oldId = old.json.id;
    r = await api('PUT', `/api/events/${oldId}`,
      { event_time: '2026-10-07T08:00', type: 'PROCESS', equipment_id: 2, batch_code: 'B-OLD',
        material_inputs: [{ material_id: M, lot_id: L2 }], ref_batch_ids: [] });
    check('更正旧输入仍不补量 -> 400 QTY_REQUIRED',
      r.status === 400 && r.json.code === 'QTY_REQUIRED', r.json);
    r = await api('PUT', `/api/events/${oldId}`,
      { event_time: '2026-10-07T08:00', type: 'PROCESS', equipment_id: 2, batch_code: 'B-OLD',
        material_inputs: [{ material_id: M, lot_id: L2, qty_grams: 5 }], ref_batch_ids: [] });
    check('补量 5 更正成功', r.status === 200, r.json);
    b = (await api('GET', `/api/material-lots/${L2}/balance`)).json;
    check('补量后 used=5、未计量旧输入数=0', b.used_grams === 5 && b.unmeasured_input_count === 0, b);
    r = await api('PUT', `/api/events/${oldId}`,
      { event_time: '2026-10-07T08:00', type: 'PROCESS', equipment_id: 2, batch_code: 'B-OLD',
        material_inputs: [{ material_id: M, lot_id: L2, qty_grams: 6 }], ref_batch_ids: [] });
    check('补量超期初 6 -> 409 回滚', r.status === 409 && r.json.code === 'INSUFFICIENT_STOCK', r.json);

    // ---- 删除事件：释放领用（同一事务重算）----
    r = await api('DELETE', `/api/events/${oldId}`);
    check('删除事件成功', r.status === 200, r.json);
    b = (await api('GET', `/api/material-lots/${L2}/balance`)).json;
    check('删除后领用归零、可用恢复 5', b.used_grams === 0 && b.available_grams === 5, b);

    // ---- 列表查询 / state 挂卡 ----
    r = await api('GET', `/api/lot-balances?material_id=${M}`);
    check('余额列表含该原料全部批号', r.status === 200 &&
      r.json.balances.some((x) => x.lot_id === L && x.opening_grams === 100), r.json);
    const state2 = (await api('GET', '/api/state')).json;
    const matCard = state2.materials.find((x) => x.id === M);
    const lcard = matCard.lots.find((x) => x.id === L);
    check('/api/state 批号卡片带 measured/期初/入库/领用/可用量/未计量旧输入数',
      lcard.measured && lcard.opening_grams === 100 && lcard.inbound_grams === 50 &&
      typeof lcard.available_grams === 'number', lcard);

    // ---- 入库流水查询 ----
    r = await api('GET', `/api/lot-inbound?lot_id=${L}`);
    check('入库流水可查且只含本批号 GR-001',
      r.json.receipts.length === 1 && r.json.receipts[0].receipt_no === 'GR-001', r.json);

    // ---- 已计量批号不可删除 ----
    r = await api('DELETE', `/api/material-lots/${L}`);
    check('已登记期初的批号不可删除 -> 400 LOT_IN_USE', r.status === 400, r.json);
  } finally {
    proc.kill();
  }

  if (failures) {
    console.error(`\n${failures} 项失败`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch((err) => { console.error(err); process.exit(1); });
