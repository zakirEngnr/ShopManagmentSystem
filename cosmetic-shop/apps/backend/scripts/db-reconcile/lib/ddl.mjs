// SQL / DDL helpers.
//
// All identifiers that reach SQL are quoted through quoteIdent(); all string
// literals that reach SQL are quoted through quoteLiteral(). Nothing is
// interpolated raw.
import { splitSql } from './sqlite.mjs';

export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const CREATE_TABLE_RE =
  /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)/i;

/** Split a CREATE TABLE body into top-level comma separated parts. */
export function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let buf = '';
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      buf += c;
      if (c === quote) {
        if (body[i + 1] === quote) {
          buf += body[i + 1];
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      buf += c;
      continue;
    }
    if (c === '[') {
      const end = body.indexOf(']', i);
      buf += body.slice(i, end === -1 ? body.length : end + 1);
      i = end === -1 ? body.length : end;
      continue;
    }
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) {
      parts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

/** Extract the name and the body parts of a CREATE TABLE statement. */
export function parseCreateTable(sql) {
  if (!sql) return null;
  const m = CREATE_TABLE_RE.exec(sql.trim());
  if (!m) return null;
  const name = unquoteIdent(m[1]);
  const open = sql.indexOf('(', m.index + m[0].length - 1);
  if (open === -1) return { name, body: '', parts: [], trailing: sql.slice(m.index + m[0].length) };
  // Find the matching closing parenthesis of the table body.
  let depth = 0;
  let close = -1;
  let quote = null;
  for (let i = open; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '(') depth += 1;
    if (c === ')') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return { name, body: '', parts: [], trailing: '' };
  const body = sql.slice(open + 1, close);
  return { name, body, parts: splitTopLevel(body), trailing: sql.slice(close + 1).trim() };
}

export function unquoteIdent(raw) {
  const s = String(raw);
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/""/g, '"');
  if (s.startsWith('`') && s.endsWith('`')) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1);
  return s;
}

const TABLE_CONSTRAINT_RE = /^(CONSTRAINT|FOREIGN\s+KEY|PRIMARY\s+KEY|UNIQUE|CHECK)\b/i;

/** Column definitions of a table, keyed by column name. */
export function columnDefinitions(sql) {
  const parsed = parseCreateTable(sql);
  const defs = new Map();
  if (!parsed) return defs;
  for (const part of parsed.parts) {
    if (TABLE_CONSTRAINT_RE.test(part)) continue;
    const m = /^("(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)\s+([\s\S]*)$/.exec(part);
    if (!m) continue;
    const name = unquoteIdent(m[1]);
    defs.set(name, { name, definition: part, rest: m[2] });
  }
  return defs;
}

/** Table-level constraints (FK / UNIQUE / CHECK / named constraints). */
export function tableConstraints(sql) {
  const parsed = parseCreateTable(sql);
  if (!parsed) return [];
  return parsed.parts.filter((part) => TABLE_CONSTRAINT_RE.test(part));
}

/** Parse a DDL script into { tables: Map, indexes: Map<Table, index[]> }. */
export function parseDdlScript(sql) {
  const tables = new Map();
  const indexes = new Map();
  for (const statement of splitSql(sql)) {
    const t = /^CREATE\s+TABLE\s+("(?:[^"]|"")+")\s*\(/i.exec(statement);
    if (t) {
      tables.set(unquoteIdent(t[1]), statement);
      continue;
    }
    const i = /^CREATE\s+(UNIQUE\s+)?INDEX\s+("(?:[^"]|"")+")\s+ON\s+("(?:[^"]|"")+")\s*\(([^)]*)\)/i.exec(
      statement,
    );
    if (i) {
      const table = unquoteIdent(i[3]);
      if (!indexes.has(table)) indexes.set(table, []);
      indexes.get(table).push({
        name: unquoteIdent(i[2]),
        unique: Boolean(i[1]),
        columns: i[4]
          .split(',')
          .map((c) => unquoteIdent(c.trim()))
          .filter(Boolean),
        sql: statement,
      });
    }
  }
  return { tables, indexes };
}

/** Normalise a DEFAULT expression into a comparable shape. */
export function normaliseDefault(raw) {
  if (raw === null || raw === undefined) return null;
  let v = String(raw).trim();
  while (v.startsWith('(') && v.endsWith(')')) v = v.slice(1, -1).trim();
  if (v === '') return null;
  const quoted = /^'(.*)'$/s.exec(v) ?? /^"(.*)"$/s.exec(v);
  if (quoted) return { kind: 'string', value: quoted[1] };
  if (/^true$/i.test(v)) return { kind: 'bool', value: true };
  if (/^false$/i.test(v)) return { kind: 'bool', value: false };
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) return { kind: 'number', value: Number(v) };
  if (/^current_timestamp$/i.test(v)) return { kind: 'now' };
  if (/^null$/i.test(v)) return { kind: 'null' };
  return { kind: 'expr', value: v.toLowerCase() };
}

export function defaultEquals(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'number') return a.value === b.value;
  return a.value === b.value;
}

export function describeDefault(d) {
  if (d === null) return 'no default';
  if (d.kind === 'string') return `default '${d.value}'`;
  if (d.kind === 'bool') return `default ${d.value}`;
  if (d.kind === 'number') return `default ${d.value}`;
  if (d.kind === 'now') return 'default CURRENT_TIMESTAMP';
  if (d.kind === 'null') return 'default NULL';
  return `default ${d.value}`;
}

/** Duplicate detector for a (possibly composite) unique index. */
export function duplicateCheckSql(table, columns) {
  const cols = columns.map(quoteIdent).join(', ');
  const notNull = columns.map((c) => `${quoteIdent(c)} IS NOT NULL`).join(' AND ');
  return `SELECT COUNT(*) AS violations FROM (SELECT ${cols} FROM ${quoteIdent(table)} WHERE ${notNull} GROUP BY ${cols} HAVING COUNT(*) > 1);`;
}

/** Orphan detector for a foreign key. */
export function orphanCheckSql(table, from, parent, to) {
  return (
    `SELECT COUNT(*) AS violations FROM ${quoteIdent(table)} t ` +
    `LEFT JOIN ${quoteIdent(parent)} p ON t.${quoteIdent(from)} = p.${quoteIdent(to)} ` +
    `WHERE t.${quoteIdent(from)} IS NOT NULL AND p.${quoteIdent(to)} IS NULL;`
  );
}
