// Expected-schema generation.
//
// Two independent references are produced and diffed against each other:
//
//   1. PRISMA INTENT   - the DDL Prisma generates from schema.prisma
//                        (`prisma migrate diff --from-empty --to-schema ... --script`)
//   2. MIGRATION CHAIN - the schema produced by replaying the migration files
//                        on an empty database
//
// Both are turned into specs with the *same* introspector, so the expected and
// the actual side of the comparison always use identical semantics.
//
// The Prisma CLI is invoked with an isolated DATABASE_URL pointing at a
// throw-away file inside the work directory: the tool never lets the CLI see
// the real shop.db, and never uses DATABASE_URL from the environment.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { all, execScript, openWritable, splitSql } from './sqlite.mjs';
import { introspect } from './introspect.mjs';
import { parseDdlScript } from './ddl.mjs';

export function listMigrations(migrationsDir) {
  const dir = path.resolve(migrationsDir);
  if (!fs.existsSync(dir)) throw new Error(`migrations directory not found: ${dir}`);
  return fs
    .readdirSync(dir)
    .filter((n) => fs.existsSync(path.join(dir, n, 'migration.sql')))
    .sort();
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Generate (or reuse) the Prisma intent DDL.
 * Throws a descriptive error when the Prisma CLI is unavailable so the caller
 * can fall back to a supplied --expected-ddl file.
 */
export function generateIntentDdl({ schemaPath, workDir, cliCwd, allowCli = true }) {
  const schema = path.resolve(schemaPath);
  if (!fs.existsSync(schema)) throw new Error(`schema.prisma not found: ${schema}`);
  fs.mkdirSync(workDir, { recursive: true });

  const key = crypto
    .createHash('sha256')
    .update(sha256File(schema))
    .update(String(prismaVersion()))
    .digest('hex')
    .slice(0, 16);
  const cacheFile = path.join(workDir, `expected-ddl-${key}.sql`);

  if (fs.existsSync(cacheFile)) {
    return { sql: fs.readFileSync(cacheFile, 'utf8'), cacheFile, cached: true };
  }
  if (!allowCli) {
    throw new Error('expected DDL not available and the Prisma CLI is disabled');
  }

  const probe = path.join(workDir, 'prisma-cli-probe.db');
  fs.rmSync(probe, { force: true });
  const env = {
    ...process.env,
    // The Prisma CLI reads prisma.config.ts, which resolves the datasource
    // from DATABASE_URL. Point it at a throw-away file so the CLI can never
    // see - let alone touch - the real shop.db.
    DATABASE_URL: `file:${probe}`,
  };

  const attempts = [
    ['migrate', 'diff', '--from-empty', '--to-schema', schema, '--script'],
    ['migrate', 'diff', '--from-empty', '--to-schema-datamodel', schema, '--script'],
  ];
  let lastError = null;
  for (const args of attempts) {
    try {
      const out = execFileSync('npx', ['prisma', ...args], {
        cwd: cliCwd,
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (out.trim()) {
        fs.writeFileSync(cacheFile, out);
        return { sql: out, cacheFile, cached: false };
      }
      lastError = new Error('the Prisma CLI produced no output');
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `could not generate the expected DDL with the Prisma CLI: ${lastError?.message ?? 'unknown error'}\n` +
      'Supply a previously generated file with --expected-ddl <file>.',
  );
}

function prismaVersion() {
  try {
    const out = execFileSync('npx', ['prisma', '--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /prisma\s+:([^\s]+)/.exec(out)?.[1] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Apply the intent DDL to a throw-away database and introspect it. */
export function buildSpecFromDdl(ddlSql, dbPath) {
  const parsed = parseDdlScript(ddlSql);
  fs.rmSync(dbPath, { force: true });
  const db = openWritable(dbPath);
  try {
    for (const [, statement] of parsed.tables) db.exec(statement);
    for (const [, list] of parsed.indexes) for (const idx of list) db.exec(idx.sql);
  } finally {
    db.close();
  }
  const reader = openWritable(dbPath);
  try {
    return { spec: introspect(reader), ddl: parsed };
  } finally {
    reader.close();
  }
}

/**
 * Replay the migration chain on an empty database.
 * Each migration file runs in autocommit mode, which is what the PRAGMA
 * statements inside the migration files expect (PRAGMA foreign_keys is a
 * no-op inside a transaction).
 */
export function buildSpecFromMigrations(migrationsDir, dbPath) {
  const names = listMigrations(migrationsDir);
  fs.rmSync(dbPath, { force: true });
  const db = openWritable(dbPath);
  const applied = [];
  try {
    for (const name of names) {
      const sql = fs.readFileSync(path.join(migrationsDir, name, 'migration.sql'), 'utf8');
      for (const statement of splitSql(sql)) db.exec(statement);
      applied.push(name);
    }
  } finally {
    db.close();
  }
  const reader = openWritable(dbPath);
  try {
    return { spec: introspect(reader), applied };
  } finally {
    reader.close();
  }
}

/** Cumulative spec after each migration (used to verify migration effects). */
export function buildCumulativeSpecs(migrationsDir, workDir) {
  const names = listMigrations(migrationsDir);
  const map = new Map();
  names.forEach((name, index) => {
    const dbPath = path.join(workDir, `chain-${index + 1}.db`);
    fs.rmSync(dbPath, { force: true });
    const db = openWritable(dbPath);
    try {
      for (const n of names.slice(0, index + 1)) {
        const sql = fs.readFileSync(path.join(migrationsDir, n, 'migration.sql'), 'utf8');
        for (const statement of splitSql(sql)) db.exec(statement);
      }
    } finally {
      db.close();
    }
    const reader = openWritable(dbPath);
    try {
      map.set(name, introspect(reader));
    } finally {
      reader.close();
    }
  });
  return map;
}

export function sqliteSequenceOf(db, table) {
  const row = all(db, `SELECT seq FROM sqlite_sequence WHERE name = ?`, [table])[0];
  return row ? Number(row.seq) : null;
}
