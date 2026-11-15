// Test database isolation guard.
//
// Every database that a test touches must live inside ONE explicitly
// designated temporary directory:
//
//     <os.tmpdir()>/cosmetic-shop-backend-tests/
//
// The guard rejects - loudly and immediately - any DATABASE_URL that
//   * is missing
//   * is not a local file URL
//   * resolves outside the designated directory
//   * points at the development database (shop.db), one of its backups or a
//     WAL/SHM side file, no matter where it was copied to
//
// The guard is deliberately independent of the reconciliation tool so that the
// test suite can never depend on production tooling for its own safety.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(HERE, '..');

/** The one directory every test database must live in. */
export const TEST_DB_ROOT = path.join(fs.realpathSync(os.tmpdir()), 'cosmetic-shop-backend-tests');

// shop.db and every derived file: shop.db, shop.db-wal, shop.db-shm,
// shop.db.BACKUP-20261109-123638, shop.db.pre-restore-…, shop.db.bak.1792328119 …
export const PROTECTED_DB_NAME = /^shop\.db([.-].*)?$/i;

/** Directories that must never hold a test database. */
export const PROTECTED_DIRS = [path.join(BACKEND_ROOT, 'backups')];

export function ensureTestDbRoot() {
  fs.mkdirSync(TEST_DB_ROOT, { recursive: true, mode: 0o700 });
  return TEST_DB_ROOT;
}

/**
 * Resolve a libSQL/Prisma `file:` URL to an absolute path.
 *   file:./shop.db        -> <cwd>/shop.db
 *   file:/abs/path.db     -> /abs/path.db
 *   file:///abs/path.db   -> /abs/path.db
 */
export function resolveDatabaseUrl(url, cwd = process.cwd()) {
  const raw = String(url).trim();
  if (!raw.startsWith('file:')) {
    throw new Error(
      `DATABASE_URL must be a local "file:" URL (got "${raw}"). ` +
        'Tests must never talk to a remote database.',
    );
  }
  let rest = raw.slice('file:'.length);
  if (rest.startsWith('///')) rest = rest.slice(2);
  const resolved = path.resolve(cwd, rest);
  // Resolve symlinks so a link inside the temp directory cannot point at the
  // development database.
  try {
    return fs.realpathSync(resolved);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

/** Why a path is not usable as a test database (null when it is fine). */
export function protectedReason(absolutePath) {
  const base = path.basename(absolutePath);
  if (PROTECTED_DB_NAME.test(base)) {
    return `it is the development database or one of its side/back-up files ("${base}")`;
  }
  for (const dir of PROTECTED_DIRS) {
    if (absolutePath === dir || absolutePath.startsWith(dir + path.sep)) {
      return `it is inside the protected backup directory (${dir})`;
    }
  }
  return null;
}

export function isInsideRoot(absolutePath, root) {
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  return absolutePath === realRoot || absolutePath.startsWith(realRoot + path.sep);
}

/**
 * The guard. Returns the resolved absolute path of an isolated test database
 * or throws with a precise reason.
 *
 * @param {string|undefined|null} url  the DATABASE_URL to check
 * @param {object} [options]
 * @param {string[]} [options.roots]    allowed roots (defaults to TEST_DB_ROOT)
 * @param {string}   [options.cwd]      base directory for relative URLs
 */
export function assertIsolatedDatabaseUrl(url, options = {}) {
  const roots = options.roots ?? [TEST_DB_ROOT];
  const cwd = options.cwd ?? process.cwd();

  if (url === undefined || url === null || String(url).trim() === '') {
    throw new Error(
      'refusing to run: DATABASE_URL is not set.\n' +
        `Every test database must be inside ${TEST_DB_ROOT}.\n` +
        'Use createTempDb() from test-support/tempDb.js, or set DATABASE_URL to a file in that directory.',
    );
  }

  const absolute = resolveDatabaseUrl(url, cwd);

  const reason = protectedReason(absolute);
  if (reason) {
    throw new Error(
      `refusing to run: DATABASE_URL points at a protected file (${absolute}) - ${reason}.\n` +
        'Tests must never read or write the development database or its backups.',
    );
  }

  const root = roots.find((r) => isInsideRoot(absolute, r));
  if (!root) {
    throw new Error(
      `refusing to run: DATABASE_URL (${absolute}) is not inside the designated test ` +
        `database directory.\nAllowed: ${roots.join(', ')}\n` +
        'Copy the database to a temporary location first, or use createTempDb().',
    );
  }
  return absolute;
}

/** Create a unique, empty database path inside the designated directory. */
export function makeIsolatedDbPath(prefix = 'db-') {
  ensureTestDbRoot();
  const dir = fs.mkdtempSync(path.join(TEST_DB_ROOT, prefix));
  return path.join(dir, 'test.db');
}

/** A unique database URL inside the designated directory. */
export function makeIsolatedDbUrl(prefix = 'db-') {
  return `file:${makeIsolatedDbPath(prefix)}`;
}
