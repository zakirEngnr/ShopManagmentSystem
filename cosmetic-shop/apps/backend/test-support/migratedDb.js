// A throw-away database with a REAL Prisma migration history.
//
// `createTempDb` uses "prisma db push", which creates the current schema but
// no _prisma_migrations table. The migration tests need the opposite: a
// database that was built by "prisma migrate deploy", so that its migration
// history is exactly the one the repository describes.
//
// Everything happens inside the designated test database directory; the
// development database is never opened.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { TEST_DB_ROOT, ensureTestDbRoot, assertIsolatedDatabaseUrl } from './dbGuard.js';

/**
 * Build a throw-away database by applying every migration of the repository.
 *
 * @param {object} options
 * @param {string} options.prefix - The prefix of the temporary directory.
 * @param {string} options.backendDir - The apps/backend directory.
 * @returns {Promise<object>} { tmpDir, dbFile, dbUrl, realTmp, cleanup }
 */
export async function createMigratedTempDb({ prefix, backendDir }) {
  const realTmp = fs.realpathSync(os.tmpdir());
  ensureTestDbRoot();
  const tmpDir = fs.mkdtempSync(path.join(TEST_DB_ROOT, prefix));
  const dbFile = path.join(tmpDir, 'migrated.db');
  const dbUrl = `file:${dbFile}`;
  assertIsolatedDatabaseUrl(dbUrl, { roots: [TEST_DB_ROOT, realTmp].filter(Boolean) });

  const uploadDir = path.join(tmpDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });

  const cleanup = () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  };

  try {
    const prismaBin = path.join(backendDir, 'node_modules', '.bin', 'prisma');
    execFileSync(prismaBin, ['migrate', 'deploy'], {
      cwd: backendDir,
      env: {
        ...process.env,
        DATABASE_URL: dbUrl,
        UPLOAD_DIR: uploadDir,
        // The migrations must never be interactive.
        CHECKPOINT_DISABLE: '1',
      },
      stdio: 'pipe',
    });
    return { tmpDir, dbFile, dbUrl, realTmp, cleanup, uploadDir };
  } catch (err) {
    cleanup();
    throw new Error(`the migrated test database could not be created: ${err.stderr || err.message}`);
  }
}

export { assertIsolatedDatabaseUrl };
