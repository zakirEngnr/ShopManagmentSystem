// SQLite connection helpers.
//
// Everything the tool does to a database goes through this module so that
//   * read-only mode is the default and is enforced at the file-descriptor level
//   * the connection pragmas the tool relies on are set explicitly and are
//     restored afterwards
//   * statement splitting understands trigger bodies (BEGIN ... END)
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Open a database read-only. SQLite's read-only mode cannot create WAL/SHM
 * side files, which is exactly what we want for an audit.
 */
export function openReadOnly(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`database file does not exist: ${dbPath}`);
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    return db;
  } catch (err) {
    throw new Error(
      `cannot open ${dbPath} read-only: ${err.message}\n` +
        'If the database is in WAL mode, the -wal/-shm side files must be present and\n' +
        'readable. Copy the whole set of files to a disposable directory and retry.',
    );
  }
}

/** Open a database for writing. Foreign keys stay OFF unless asked for. */
export function openWritable(dbPath) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(path.resolve(dbPath));
  db.exec('PRAGMA foreign_keys = OFF;');
  return db;
}

export function all(db, sql, params = []) {
  return db.prepare(sql).all(...params).map((r) => ({ ...r }));
}

export function get(db, sql, params = []) {
  const row = db.prepare(sql).get(...params);
  return row === undefined ? undefined : { ...row };
}

export function run(db, sql, params = []) {
  return db.prepare(sql).run(...params);
}

export function execScript(db, sql) {
  db.exec(sql);
}

export function tableExists(db, name) {
  return (
    all(db, `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [name]).length > 0
  );
}

export function sqliteVersion(db) {
  return get(db, 'SELECT sqlite_version() AS v')?.v ?? 'unknown';
}

export function journalMode(db) {
  try {
    return get(db, 'PRAGMA journal_mode')?.journal_mode ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function integrityCheck(db) {
  try {
    const rows = all(db, 'PRAGMA integrity_check');
    return rows.map((r) => Object.values(r)[0]);
  } catch (err) {
    return [`ERROR: ${err.message}`];
  }
}

export function foreignKeyCheck(db) {
  try {
    return all(db, 'PRAGMA foreign_key_check');
  } catch (err) {
    return [{ error: err.message }];
  }
}

/**
 * Split a SQL script into executable statements.
 *
 * Handles line/block comments, single quoted strings, double quoted and
 * bracket quoted identifiers, and - crucially - CREATE TRIGGER bodies, whose
 * internal semicolons must not split the statement.
 */
export function splitSql(sql) {
  const statements = [];
  let buf = '';
  let i = 0;
  const len = sql.length;

  const flush = () => {
    const trimmed = buf.trim();
    if (trimmed) statements.push(trimmed);
    buf = '';
  };

  while (i < len) {
    const c = sql[i];
    const n = sql[i + 1];

    if (c === '-' && n === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? len : nl;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let lit = c;
      i += 1;
      while (i < len) {
        const ch = sql[i];
        lit += ch;
        if (ch === quote) {
          if (sql[i + 1] === quote) {
            lit += quote;
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      buf += lit;
      continue;
    }
    if (c === '[') {
      const end = sql.indexOf(']', i);
      const lit = end === -1 ? sql.slice(i) : sql.slice(i, end + 1);
      buf += lit;
      i = end === -1 ? len : end + 1;
      continue;
    }
    if (c === ';') {
      const statement = buf.trim();
      // A trigger body ends with "END" - keep it together.
      if (/^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(statement)) {
        const end = consumeTriggerBody(sql, i + 1);
        buf += sql.slice(i, end);
        i = end;
        flush();
        continue;
      }
      flush();
      i += 1;
      continue;
    }
    buf += c;
    i += 1;
  }
  flush();
  return statements;
}

/**
 * Given the position just after a semicolon that terminated a CREATE TRIGGER
 * statement, return the index just after the matching END; of the trigger body.
 */
function consumeTriggerBody(sql, from) {
  let depth = 0;
  let i = from;
  const len = sql.length;
  while (i < len) {
    const word = /\b(BEGIN|END|CASE)\b/gi;
    word.lastIndex = i;
    const m = word.exec(sql);
    if (!m) break;
    const token = m[0].toUpperCase();
    if (token === 'CASE') {
      // CASE ... END uses END as well; track both.
      depth += 1;
    } else if (token === 'BEGIN') {
      depth += 1;
    } else if (token === 'END') {
      depth -= 1;
      if (depth === 0) {
        const semi = sql.indexOf(';', m.index);
        return semi === -1 ? len : semi + 1;
      }
    }
    i = m.index + m[0].length;
  }
  return len;
}
