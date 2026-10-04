'use strict';
// 仓管批号计量：期初实物结存 + 入库流水 + 投料领用余额。
//
// 计量生命周期：
//   1) 仓管为已有供应批号登记一次“期初实物结存”（非负整数克，每批号至多一次，只增不改）；
//      登记成功即“启用计量”。此前该批号已存在的投料输入全部保留 NULL 数量
//      （未计量旧输入，不计入领用），更正这些输入时必须补正整数克数。
//   2) 启用后以“唯一入库单号”登记正整数克入库；入库流水只增不改。
//      未启用计量（未登记期初）的批号一律不可登记入库。
//   3) 此后新增、断网补录或更正加工事件时，该批号的每笔原料输入都必须填正整数克数
//      （qty_grams）；按批号累计领用（只累计带数量的输入）不得超过“期初 + 入库”之和。
//      未启用批号沿用原输入规则（不填数量；若对未启用批号填了数量则拒绝）。
//   4) 事件删除、更正、整组换线确认：在同一事务中按最终事件集重算领用，
//      任一启用批号余额不足则整次拒绝，原事件、库存（流水/结存）均不变。
//      换线预演只展示各批号余额差异，不占用库存。
//
// 断网补录：同内容重试或复用既有外部记录号均不写入新事件，故不重复领用
// （领用只由最终事件集重算，台账重试路径不产生额外投料行）。

class StockError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'StockError';
    this.code = code;
    this.details = details || [];
  }
}

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function nowIso() {
  return new Date().toISOString().slice(0, 19);
}

function getLotOrThrow(db, lot_id) {
  const lot = db.prepare(
    `SELECT l.id, l.material_id, l.lot_code, m.code AS material_code, m.name AS material_name
       FROM material_lots l JOIN materials m ON m.id = l.material_id
      WHERE l.id = ?`
  ).get(lot_id);
  if (!lot) throw new StockError('LOT_NOT_FOUND', `供应批号 #${lot_id} 不存在`);
  return lot;
}

// 解析非负整数（0、正整数字符串均可）；非法返回 null。
function parseNonNegInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

// 解析正整数；非法返回 null。
function parsePosInt(v) {
  const n = parseNonNegInt(v);
  return n !== null && n > 0 ? n : null;
}

// ---------- 期初实物结存（每批号一次，只增不改）----------
function registerOpening(db, body) {
  body = body || {};
  const lot_id = parseInt(body.lot_id, 10);
  if (!Number.isInteger(lot_id)) throw new StockError('INVALID_REQUEST', '请选择供应批号 lot_id');
  const lot = getLotOrThrow(db, lot_id);

  const qty = parseNonNegInt(body.qty_grams);
  if (qty === null) {
    throw new StockError('INVALID_REQUEST', '期初实物结存 qty_grams 必须是非负整数克数（允许 0）');
  }
  const registered_by = String(body.registered_by || body.operator || '').trim();
  const note = String(body.note || '').trim();

  try {
    db.prepare(
      `INSERT INTO lot_opening_balances (lot_id, qty_grams, registered_by, note)
       VALUES (?,?,?,?)`
    ).run(lot_id, qty, registered_by, note);
    return getBalanceRow(db, lot_id);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new StockError(
        'OPENING_ALREADY_EXISTS',
        `供应批号 ${lot.lot_code}（${lot.material_code}）已登记过期初实物结存，` +
        '期初只可登记一次且只增不改；后续到货请登记入库单',
        [`lot_id=${lot_id}`]
      );
    }
    throw err;
  }
}

// ---------- 入库流水（只增不改；唯一单号、正整数克）----------
function createInbound(db, body) {
  body = body || {};
  const lot_id = parseInt(body.lot_id, 10);
  if (!Number.isInteger(lot_id)) throw new StockError('INVALID_REQUEST', '请选择供应批号 lot_id');
  const lot = getLotOrThrow(db, lot_id);

  const receipt_no = String(body.receipt_no || body.receipt_code || '').trim();
  if (!receipt_no) throw new StockError('INVALID_REQUEST', '入库单号 receipt_no 不能为空');

  const qty = parsePosInt(body.qty_grams);
  if (qty === null) {
    throw new StockError('INVALID_REQUEST', '入库克数 qty_grams 必须是正整数');
  }

  const received_at = String(body.received_at || '').trim() || nowIso();
  if (!TIME_RE.test(received_at)) {
    throw new StockError('INVALID_REQUEST', '入库时间格式应为 YYYY-MM-DDTHH:MM，例如 2026-10-04T09:30');
  }
  const received_by = String(body.received_by || body.operator || '').trim();
  const note = String(body.note || '').trim();

  // 未启用计量（未登记期初）的批号不可入库。
  const opening = db.prepare(
    'SELECT id, qty_grams FROM lot_opening_balances WHERE lot_id = ?'
  ).get(lot_id);
  if (!opening) {
    throw new StockError(
      'LOT_NOT_MEASURED',
      `供应批号 ${lot.lot_code}（${lot.material_code}）尚未登记期初实物结存（未启用计量），` +
      '请先登记期初结存，再登记入库',
      [`lot_id=${lot_id}`]
    );
  }

  try {
    const info = db.prepare(
      `INSERT INTO lot_inbound_receipts
         (receipt_no, lot_id, qty_grams, received_at, received_by, note)
       VALUES (?,?,?,?,?,?)`
    ).run(receipt_no, lot_id, qty, received_at, received_by, note);
    return getInboundRow(db, info.lastInsertRowid);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new StockError(
        'RECEIPT_NO_CONFLICT',
        `入库单号 "${receipt_no}" 已存在：入库单号必须唯一；该请求被拒绝且未产生任何流水`,
        [`receipt_no=${receipt_no}`]
      );
    }
    throw err;
  }
}

// ---------- 查询 ----------
function getInboundRow(db, id) {
  const r = db.prepare(
    `SELECT r.id, r.receipt_no, r.lot_id, r.qty_grams, r.received_at,
            r.received_by, r.note, r.created_at,
            l.lot_code, m.id AS material_id, m.code AS material_code, m.name AS material_name
       FROM lot_inbound_receipts r
       JOIN material_lots l ON l.id = r.lot_id
       JOIN materials m ON m.id = l.material_id
      WHERE r.id = ?`
  ).get(id);
  if (!r) return null;
  return {
    id: r.id,
    receipt_no: r.receipt_no,
    lot_id: r.lot_id,
    lot_code: r.lot_code,
    material_id: r.material_id,
    material_code: r.material_code,
    material_name: r.material_name,
    qty_grams: r.qty_grams,
    received_at: r.received_at,
    received_by: r.received_by,
    note: r.note,
    created_at: r.created_at
  };
}

function getBalanceRow(db, lot_id) {
  const lot = db.prepare(
    `SELECT l.id, l.lot_code, l.material_id, m.code AS material_code, m.name AS material_name
       FROM material_lots l JOIN materials m ON m.id = l.material_id WHERE l.id = ?`
  ).get(lot_id);
  if (!lot) return null;
  const opening = db.prepare(
    'SELECT id, qty_grams, registered_by, note, registered_at FROM lot_opening_balances WHERE lot_id = ?'
  ).get(lot_id);
  const inbound = db.prepare(
    `SELECT COALESCE(SUM(qty_grams),0) AS total, COUNT(*) AS count
       FROM lot_inbound_receipts WHERE lot_id = ?`
  ).get(lot_id);
  const used = db.prepare(
    `SELECT COALESCE(SUM(qty_grams),0) AS total, COUNT(*) AS count
       FROM process_inputs
      WHERE material_lot_id = ? AND qty_grams IS NOT NULL`
  ).get(lot_id);
  const unmeasured = db.prepare(
    'SELECT COUNT(*) AS c FROM process_inputs WHERE material_lot_id = ? AND qty_grams IS NULL'
  ).get(lot_id).c;

  const openingGrams = opening ? opening.qty_grams : null;
  const inboundGrams = inbound.total;
  const usedGrams = used.total;
  const measured = !!opening;
  return {
    lot_id,
    lot_code: lot.lot_code,
    material_id: lot.material_id,
    material_code: lot.material_code,
    material_name: lot.material_name,
    measured, // 是否已启用计量（已登记期初）
    opening_id: opening ? opening.id : null,
    opening_grams: openingGrams,
    opening_registered_at: opening ? opening.registered_at : null,
    opening_registered_by: opening ? opening.registered_by : '',
    opening_note: opening ? opening.note : '',
    inbound_grams: measured ? inboundGrams : 0,
    inbound_count: inbound.count,
    used_grams: measured ? usedGrams : 0,
    measured_input_count: used.count,
    // 未计量旧输入数：该批号已存在但缺少数量的输入行数（仅启用批号有意义；
    // 未启用批号所有输入本来就不计量，此数只作信息展示，不计入领用）。
    unmeasured_input_count: unmeasured,
    // 可用量 = 期初 + 入库 - 累计领用；未启用计量为 null（不存在余额概念）。
    available_grams: measured ? openingGrams + inboundGrams - usedGrams : null
  };
}

// 全部批号余额（?material_id= 可选过滤）。
function listBalances(db, { material_id = null } = {}) {
  let sql = 'SELECT id FROM material_lots';
  const args = [];
  if (material_id != null) {
    sql += ' WHERE material_id = ?';
    args.push(material_id);
  }
  sql += ' ORDER BY id';
  return db.prepare(sql).all(...args)
    .map((r) => getBalanceRow(db, r.id))
    .sort((a, b) =>
      a.material_code.localeCompare(b.material_code) ||
      a.lot_code.localeCompare(b.lot_code) || a.lot_id - b.lot_id);
}

// 便于按批号快速取用的 Map（供 /api/state 挂到批号卡片）。
function balanceMapByLot(db) {
  const map = new Map();
  for (const b of listBalances(db)) map.set(b.lot_id, b);
  return map;
}

function listInbound(db, { lot_id = null, receipt_no = null } = {}) {
  let sql =
    `SELECT r.id FROM lot_inbound_receipts r`;
  const args = [];
  const conds = [];
  if (lot_id != null) { conds.push('r.lot_id = ?'); args.push(lot_id); }
  if (receipt_no != null) { conds.push('r.receipt_no = ?'); args.push(receipt_no); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY r.received_at, r.id';
  return db.prepare(sql).all(...args).map((r) => getInboundRow(db, r.id));
}

// ---------- 写入侧规则：原料输入数量规范化 ----------
// 把调用方提供的原始数量字符串/数字解析为 正整数 | null（缺省），
// 形状非法（非整数、<=0）立即抛 StockError（INVALID_REQUEST）。
// 与“是否启用计量”无关的纯形状校验；归属/余额规则在 resolveInputQuantities /
// validateStockBalances 中强制，以便更正与换线等“按最终事件集”场景统一重算。
function normalizeQtyGrams(raw, where) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parsePosInt(raw);
  if (n === null) {
    throw new StockError(
      'INVALID_REQUEST',
      `${where}：投料克数 qty_grams 必须是正整数（大于 0 的整数克）`
    );
  }
  return n;
}

// 为一组已解析批号（{ material_id, material_lot_id }）的原料输入附加 qty_grams。
// rawQtyList 与 inputs 等长（来自请求体，形状已由上层保证；缺项按 undefined）。
// 返回 { material_id, material_lot_id, qty_grams }。
// 归属规则（不依赖最终事件集，提交前即可判定，使非法请求不产生任何写入）：
//   - 已知批号输入 + 已启用计量：必须填正整数克数（缺失即拒绝）；
//   - 已知批号输入 + 未启用计量：必须不填数量（填了即拒绝）；
//   - 批号未知输入：必须不填数量（未计量规则；填了即拒绝）。
function attachQuantities(db, inputs, rawQtyList, wherePrefix) {
  const measured = new Set(
    db.prepare('SELECT lot_id FROM lot_opening_balances').all().map((r) => r.lot_id)
  );
  return inputs.map((inp, idx) => {
    const where = `${wherePrefix || 'material_inputs'}[${idx}]`;
    const qty = normalizeQtyGrams(rawQtyList ? rawQtyList[idx] : undefined, where);
    if (inp.material_lot_id == null) {
      if (qty !== null) {
        throw new StockError(
          'QTY_ON_UNMEASURED_INPUT',
          `${where}：该输入未指定已启用计量的供应批号（批号未知/未启用），` +
          '不能填写克数；未启用批号沿用原输入规则'
        );
      }
      return { ...inp, qty_grams: null };
    }
    if (measured.has(inp.material_lot_id)) {
      if (qty === null) {
        throw new StockError(
          'QTY_REQUIRED',
          `${where}：该供应批号已启用计量（已登记期初结存），投料必须填写正整数克数 qty_grams`
        );
      }
    } else if (qty !== null) {
      throw new StockError(
        'QTY_ON_UNMEASURED_LOT',
        `${where}：该供应批号尚未登记期初实物结存（未启用计量），不能填写克数；` +
        '如需计量请先由仓管登记期初结存',
        [`lot_id=${inp.material_lot_id}`]
      );
    }
    return { ...inp, qty_grams: qty };
  });
}

// ---------- 事务内：按最终事件集重算领用并核对余额 ----------
// 任何新增/更正/删除/断网补录/换线确认后，在同一事务内调用。
// 返回 { balances: [{lot_id, lot_code, material_code, opening, inbound, used, available}],
//        shortages: [...] }；shortages 非空时由调用方抛错回滚整次提交。
function computeUsage(db) {
  const lots = db.prepare(
    `SELECT l.id AS lot_id, l.lot_code, m.code AS material_code
       FROM material_lots l JOIN materials m ON m.id = l.material_id`
  ).all();
  const openingStmt = db.prepare(
    'SELECT COALESCE(qty_grams,0) AS q FROM lot_opening_balances WHERE lot_id = ?'
  );
  const inboundStmt = db.prepare(
    'SELECT COALESCE(SUM(qty_grams),0) AS q FROM lot_inbound_receipts WHERE lot_id = ?'
  );
  const usedStmt = db.prepare(
    `SELECT COALESCE(SUM(qty_grams),0) AS q, COUNT(*) AS c
       FROM process_inputs WHERE material_lot_id = ? AND qty_grams IS NOT NULL`
  );
  const result = { balances: [], shortages: [] };
  for (const lot of lots) {
    const openingRow = db.prepare(
      'SELECT id FROM lot_opening_balances WHERE lot_id = ?'
    ).get(lot.lot_id);
    if (!openingRow) continue; // 未启用计量：不参与余额核对
    const opening = openingStmt.get(lot.lot_id).q;
    const inbound = inboundStmt.get(lot.lot_id).q;
    const usedRow = usedStmt.get(lot.lot_id);
    const used = usedRow.q;
    const available = opening + inbound - used;
    result.balances.push({
      lot_id: lot.lot_id, lot_code: lot.lot_code, material_code: lot.material_code,
      opening_grams: opening, inbound_grams: inbound, used_grams: used, available_grams: available
    });
    if (available < 0) {
      result.shortages.push({
        lot_id: lot.lot_id,
        lot_code: lot.lot_code,
        material_code: lot.material_code,
        opening_grams: opening,
        inbound_grams: inbound,
        supply_grams: opening + inbound,
        used_grams: used,
        over_grams: -available,
        message:
          `供应批号 ${lot.lot_code}（${lot.material_code}）累计领用 ${used} 克，` +
          `超过期初 ${opening} 克 + 入库 ${inbound} 克 = ${opening + inbound} 克，` +
          `超出 ${-available} 克：整次提交已回滚，原事件与库存不变`
      });
    }
  }
  return result;
}

// 供 mutateEvents / backfill / replan 事务内调用：余额不足即抛 StockError。
function assertBalances(db) {
  const { balances, shortages } = computeUsage(db);
  if (shortages.length) {
    throw new StockError(
      'INSUFFICIENT_STOCK',
      '按最终事件集重算批号领用后存在余额不足：整次提交已回滚，原事件与库存不变',
      shortages.map((s) => s.message)
    );
  }
  return balances;
}

module.exports = {
  StockError,
  registerOpening,
  createInbound,
  listBalances,
  getBalanceRow,
  balanceMapByLot,
  listInbound,
  normalizeQtyGrams,
  attachQuantities,
  computeUsage,
  assertBalances
};
