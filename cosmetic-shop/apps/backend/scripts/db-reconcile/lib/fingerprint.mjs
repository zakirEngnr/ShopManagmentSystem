// Data fingerprints.
//
// A fingerprint proves that a reconciliation preserved the data of every
// table. It is computed per column so that adding a column (which changes
// every row) is not reported as data loss, and it is order independent so that
// a table rebuild (which changes the physical row order) does not produce a
// false alarm.
//
// The accumulator is a 128 bit sum over per-value SHA-256 digests: order
// independent, duplicate sensitive and streamable, so a large table does not
// have to be held in memory.
import crypto from 'node:crypto';

const MAX_STORED_VALUES = 2000;

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

function accumulate(acc, value) {
  return acc + BigInt(`0x${digest(value).slice(0, 32)}`);
}

export function fingerprint(db, { tables = null } = {}) {
  const tableNames =
    tables ??
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((r) => r.name);

  const result = {};
  for (const name of tableNames) {
    const escaped = `"${String(name).replace(/"/g, '""')}"`;
    const statement = db.prepare(`SELECT * FROM ${escaped}`);
    const rows = typeof statement.iterate === 'function' ? statement.iterate() : statement.all();

    let count = 0;
    const columns = new Map();
    for (const row of rows) {
      count += 1;
      for (const [column, value] of Object.entries(row)) {
        if (!columns.has(column)) {
          columns.set(column, { sum: 0n, nulls: 0, values: [] });
        }
        const meta = columns.get(column);
        meta.sum += accumulate(meta.sum, value);
        if (value === null || value === undefined) meta.nulls += 1;
        if (meta.values.length < MAX_STORED_VALUES) meta.values.push(value ?? null);
      }
    }
    const perColumn = {};
    for (const [column, meta] of columns) {
      perColumn[column] = {
        hash: meta.sum.toString(16).padStart(32, '0'),
        nulls: meta.nulls,
        values: meta.values,
        valuesTruncated: count > MAX_STORED_VALUES,
      };
    }
    result[name] = { count, columns: perColumn };
  }
  return result;
}

/**
 * Compare two fingerprints.
 * A column that only changed its storage class (TEXT "100" -> INTEGER 100)
 * is reported as a coercion, not as data loss.
 */
export function diffFingerprints(before, after) {
  const deltas = [];
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[name];
    const a = after[name];
    if (!b && a) {
      deltas.push({ table: name, kind: 'created' });
      continue;
    }
    if (b && !a) {
      deltas.push({ table: name, kind: 'dropped' });
      continue;
    }
    if (b.count !== a.count) {
      deltas.push({
        table: name,
        kind: 'row-count-changed',
        before: { count: b.count },
        after: { count: a.count },
      });
      continue;
    }
    const changed = [];
    const coerced = [];
    for (const [column, meta] of Object.entries(b.columns)) {
      if (!a.columns[column]) {
        changed.push({ column, kind: 'dropped' });
        continue;
      }
      if (a.columns[column].hash !== meta.hash) {
        const equivalent =
          !meta.valuesTruncated && numericEquivalent(meta.values, a.columns[column].values);
        changed.push({
          column,
          kind: equivalent ? 'storage-class-changed' : 'content-changed',
          before: meta.values.slice(0, 10),
          after: a.columns[column].values.slice(0, 10),
        });
        if (equivalent) coerced.push(column);
      }
    }
    if (changed.length) {
      deltas.push({ table: name, kind: 'content-changed', changed, coerced });
    }
  }
  return deltas;
}

function numericEquivalent(before, after) {
  if (before.length !== after.length) return false;
  const toNumbers = (values) => {
    const nums = [];
    for (const v of values) {
      if (v === null) return null;
      const n = Number(v);
      if (Number.isNaN(n)) return null;
      nums.push(n);
    }
    return nums;
  };
  const b = toNumbers(before);
  const a = toNumbers(after);
  if (!b || !a) return false;
  const sb = b.slice().sort((x, y) => x - y);
  const sa = a.slice().sort((x, y) => x - y);
  return sb.every((v, i) => Math.abs(v - sa[i]) < 1e-9);
}

/** A delta list that contains real data loss (as opposed to a coercion). */
export function dataLossDeltas(deltas) {
  return deltas.filter((d) => {
    if (d.kind === 'dropped' || d.kind === 'row-count-changed') return true;
    if (d.kind === 'content-changed') {
      return d.changed.some((c) => c.kind !== 'storage-class-changed');
    }
    return false;
  });
}
