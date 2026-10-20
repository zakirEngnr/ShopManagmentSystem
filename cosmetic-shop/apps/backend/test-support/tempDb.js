// Shared temp-DB helper for backend integration tests.
//
// Safety contract (same as the per-file setup it replaces):
// - throwaway SQLite file under fs.realpathSync(os.tmpdir()) only
// - DATABASE_URL is set to the temp file and asserted equal after import
// - every prisma/migrations/* folder is applied in sorted order
// - only CREATE TABLE / CREATE INDEX statements are executed
// - cleanup removes the temp dir even on failure
// Env is set BEFORE any src/ module is imported by the caller.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function abortIfNotTmpDb(url, realTmp) {
  const resolved = path.resolve(String(url).replace(/^file:/, ''));
  if (!resolved.startsWith(realTmp + path.sep)) {
    throw new Error('refusing to run: DATABASE_URL is not inside os.tmpdir()');
  }
}

function splitStatements(sql) {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) =>
      s
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter(Boolean);
}

/**
 * Create a temp dir + temp SQLite file, point DATABASE_URL at it, and apply
 * every migration folder (sorted) via $executeRawUnsafe after asserting each
 * statement is a CREATE TABLE / CREATE INDEX.
 * Returns { tmpDir, dbFile, dbUrl, realTmp, cleanup }.
 */
export async function createTempDb({ prefix, backendDir }) {
  const realTmp = fs.realpathSync(os.tmpdir());
  const tmpDir = fs.mkdtempSync(path.join(realTmp, prefix));
  const dbFile = path.join(tmpDir, 'test.db');
  const dbUrl = `file:${dbFile}`;
  abortIfNotTmpDb(dbUrl, realTmp);
  process.env.DATABASE_URL = dbUrl;

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  };

  try {
    const migrationsDir = path.join(backendDir, 'prisma', 'migrations');
    const entries = fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    assert.ok(entries.length > 0, 'no migration folders found under prisma/migrations');
    const { prisma } = await import(
      (await import('node:url')).pathToFileURL(path.join(backendDir, 'src', 'db', 'prisma.js')).href
    );
    if (process.env.DATABASE_URL !== dbUrl) {
      throw new Error('refusing to run: DATABASE_URL was changed during prisma import');
    }
    assert.equal(process.env.DATABASE_URL, dbUrl);
    for (const folder of entries) {
      const sqlPath = path.join(migrationsDir, folder, 'migration.sql');
      const sql = fs.readFileSync(sqlPath, 'utf8');
      const stmts = splitStatements(sql);
      assert.ok(stmts.length > 0, `migration.sql must not be empty: ${folder}`);
      for (const s of stmts) {
        assert.match(s, /^CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)/i, 'unexpected statement: ' + s.slice(0, 60));
      }
      for (const s of stmts) {
        await prisma.$executeRawUnsafe(s + ';');
      }
    }
    return { tmpDir, dbFile, dbUrl, realTmp, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

export function assertTmpDbUrl(url, realTmp) {
  abortIfNotTmpDb(url, realTmp ?? fs.realpathSync(os.tmpdir()));
}
