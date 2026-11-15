// Path safety for the reconciliation tool.
//
// Two independent guards:
//   1. PROTECTED paths  - the real shop.db and every backup of it. These are
//      refused in EVERY mode (audit included).
//   2. DISPOSABLE roots - write operations are only allowed inside a
//      disposable root (the OS temp dir by default, or an explicit
//      --disposable-root). The real database can therefore never be written to
//      by this tool, even if the protected-path list is bypassed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/db-reconcile/lib/paths.mjs -> scripts/db-reconcile -> scripts -> apps/backend
export const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BACKEND_ROOT = path.resolve(TOOL_DIR, '..');

// The live database and every file that is a backup of it.
export const PROTECTED_BASENAMES = [/^shop\.db$/i, /^shop\.db\..*$/i];

export function isProtectedPath(target) {
  const resolved = path.resolve(target);
  const base = path.basename(resolved);
  if (PROTECTED_BASENAMES.some((re) => re.test(base))) {
    return {
      protected: true,
      reason: `file name "${base}" matches the protected shop.db / shop.db backup pattern`,
    };
  }
  const backupsDir = path.join(BACKEND_ROOT, 'backups');
  if (resolved.startsWith(backupsDir + path.sep)) {
    return { protected: true, reason: `path is inside the protected backups directory (${backupsDir})` };
  }
  return { protected: false, reason: null };
}

export function assertNotProtected(target) {
  const check = isProtectedPath(target);
  if (check.protected) {
    throw new Error(
      `refusing to touch protected database: ${path.resolve(target)} (${check.reason}).\n` +
        'This tool never operates on the live shop.db or its backups. Copy the file to a\n' +
        'disposable location first if you need to reconcile it.',
    );
  }
  return path.resolve(target);
}

/**
 * Resolve the --db argument into an absolute path.
 * Never falls back to DATABASE_URL and never picks a database automatically.
 */
export function resolveTargetPath(dbArg) {
  if (!dbArg || typeof dbArg !== 'string' || dbArg.trim() === '') {
    throw new Error(
      'missing required argument --db <path-to-sqlite-file>.\n' +
        'This tool never selects a database automatically and never reads DATABASE_URL.\n' +
        'Pass the exact file you want to audit, e.g. --db /tmp/audit-copy.db',
    );
  }
  let raw = dbArg.trim();
  if (raw.startsWith('file://')) raw = raw.slice('file://'.length);
  else if (raw.startsWith('file:')) raw = raw.slice('file:'.length);
  const resolved = path.resolve(raw);
  assertNotProtected(resolved);
  return resolved;
}

export function realTempDir() {
  return fs.realpathSync(os.tmpdir());
}

/**
 * A path is disposable when it lives inside one of the disposable roots.
 * Write operations are refused for everything else.
 */
export function isDisposable(target, disposableRoots) {
  const resolved = path.resolve(target);
  for (const root of disposableRoots) {
    const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
    if (resolved === realRoot) return { disposable: true, root: realRoot };
    if (resolved.startsWith(realRoot + path.sep)) return { disposable: true, root: realRoot };
  }
  return { disposable: false, root: null };
}

export function defaultDisposableRoots() {
  return [realTempDir()];
}

/** Identity of a file, printed before anything else happens. */
export function describeFile(target) {
  const stat = fs.statSync(target);
  return {
    path: path.resolve(target),
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sha256: sha256File(target),
  };
}

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}
