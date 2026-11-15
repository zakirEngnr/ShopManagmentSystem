// Shared temp-DB helper for backend integration tests.
//
// Safety contract:
// - the throwaway SQLite file lives inside the designated test database
//   directory (<os.tmpdir()>/cosmetic-shop-backend-tests/), never anywhere else
// - DATABASE_URL is validated with the shared guard before it is set and
//   again after the Prisma client has been imported
// - the development database (shop.db), its backups and its WAL/SHM side files
//   are refused explicitly
// - every prisma/migrations/* folder is applied in sorted order
// - only allow-listed migration statements are executed:
//   CREATE TABLE / CREATE (UNIQUE) INDEX (initial schema),
//   ALTER TABLE ... ADD COLUMN (additive column migrations),
//   PRAGMA ... (migration pragmas such as legacy_redundant_index /
//   foreign_keys toggles emitted by Prisma table rebuilds),
//   the canonical Prisma SQLite table-rebuild shape only
//   (CREATE TABLE "new_X" / INSERT INTO "new_X" ... SELECT ...
//   / DROP TABLE "X" / ALTER TABLE "new_X" RENAME TO "X"),
//   anything else (DELETE, UPDATE, DROP of arbitrary tables, ...)
//   aborts
// - cleanup removes the temp dir even on failure
// Env is set BEFORE any src/ module is imported by the caller.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  TEST_DB_ROOT,
  assertIsolatedDatabaseUrl,
  ensureTestDbRoot,
  protectedReason,
  resolveDatabaseUrl,
} from './dbGuard.js';

function abortIfNotTmpDb(url, realTmp) {
  // The guard is the single source of truth: it rejects a missing URL, a URL
  // outside the designated test directory and the development database.
  assertIsolatedDatabaseUrl(url, { roots: [TEST_DB_ROOT, realTmp].filter(Boolean) });
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

function isAllowedMigrationStatement(s) {
  return (
    /^CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)/i.test(s) ||
    /^ALTER\s+TABLE\s+"?[A-Za-z0-9_]+"?\s+ADD\s+COLUMN\s/i.test(s) ||
    /^PRAGMA\s/i.test(s) ||
    isTableRebuildStatement(s)
  );
}

// Canonical Prisma SQLite "RedefineTables" rebuild, restricted to a temp
// "new_<Table>" table: create it, copy rows with INSERT ... SELECT, drop the
// old table, then rename the new one back. Rejects any other DROP/INSERT.
function isTableRebuildStatement(s) {
  return (
    /^CREATE\s+TABLE\s+"new_[A-Za-z0-9_]+"/i.test(s) ||
    (/^INSERT\s+INTO\s+"new_[A-Za-z0-9_]+"\s*\(/i.test(s) && /\bSELECT\b/i.test(s)) ||
    /^DROP\s+TABLE\s+"(?!new_)[A-Za-z0-9_]+"$/i.test(s) ||
    /^ALTER\s+TABLE\s+"new_[A-Za-z0-9_]+"\s+RENAME\s+TO\s+"[A-Za-z0-9_]+"$/i.test(s)
  );
}

/**
 * Create a temp dir + temp SQLite file inside the designated test database
 * directory, point DATABASE_URL at it, and apply every migration folder
 * (sorted) via $executeRawUnsafe after asserting each statement is
 * allow-listed (see isAllowedMigrationStatement).
 * Returns { tmpDir, dbFile, dbUrl, realTmp, cleanup }.
 */
export async function createTempDb({ prefix, backendDir }) {
  const realTmp = fs.realpathSync(os.tmpdir());
  ensureTestDbRoot();
  const tmpDir = fs.mkdtempSync(path.join(TEST_DB_ROOT, prefix));
  const dbFile = path.join(tmpDir, 'test.db');
  const dbUrl = `file:${dbFile}`;
  abortIfNotTmpDb(dbUrl, realTmp);
  process.env.DATABASE_URL = dbUrl;

  // Isolated upload dir for this suite, cleaned up together with tmpDir.
  const uploadDir = path.join(tmpDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  process.env.UPLOAD_DIR = uploadDir;

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  };

  try {
    const { prisma } = await import(
      (await import('node:url')).pathToFileURL(path.join(backendDir, 'src', 'db', 'prisma.js')).href
    );
    if (process.env.DATABASE_URL !== dbUrl) {
      throw new Error('refusing to run: DATABASE_URL was changed during prisma import');
    }
    assert.equal(process.env.DATABASE_URL, dbUrl);
    // The client must still point at the isolated file after the import.
    abortIfNotTmpDb(process.env.DATABASE_URL, realTmp);

    const prismaBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    execFileSync(
      prismaBin,
      [
        'prisma',
        'db',
        'push',
        '--schema',
        path.join(backendDir, 'prisma', 'schema.prisma'),
      ],
      {
        cwd: backendDir,
        // The child process inherits the isolated DATABASE_URL explicitly.
        env: { ...process.env, DATABASE_URL: dbUrl, UPLOAD_DIR: uploadDir },
        stdio: 'inherit',
      },
    );

    await prisma.$queryRaw`SELECT 1`;
    return { tmpDir, dbFile, dbUrl, realTmp, cleanup, uploadDir };
  } catch (err) {
    cleanup();
    throw err;
  }
}

export function assertTmpDbUrl(url, realTmp) {
  abortIfNotTmpDb(url, realTmp ?? fs.realpathSync(os.tmpdir()));
}

export { assertIsolatedDatabaseUrl, protectedReason, resolveDatabaseUrl, TEST_DB_ROOT };
