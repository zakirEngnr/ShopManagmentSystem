// The ONE place that turns a DATABASE_URL into the file of the database.
//
// The backup service and the restore script MUST agree on this. They did not
// (D24 finding F08): the service resolved a relative URL against the working
// directory and the script resolved it against apps/backend, so a backup could
// be taken from one file and restored over another.
//
// Rules:
//   * a relative path is resolved against the BACKEND ROOT (apps/backend), not
//     against the working directory, so the location of the database never
//     depends on where a command was started from;
//   * an absolute path is used as it is;
//   * the file: prefix is removed and the remaining path is URL decoded.
//
// The path of the running shop database is NOT changed by this module: the
// DATABASE_URL of the shop is "file:./shop.db", which resolves to
// apps/backend/shop.db both before and after this change.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// src/utils/databasePath.js -> src/utils -> src -> apps/backend
export const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Describe a DATABASE_URL without exposing anything secret.
 * Only the scheme is ever shown.
 */
export function describeDatabaseUrl(databaseUrl) {
  const raw = String(databaseUrl ?? '').trim();
  if (!raw) return '(not set)';
  const scheme = raw.includes(':') ? raw.slice(0, raw.indexOf(':')) : '(no scheme)';
  return `${scheme}:...`;
}

/**
 * Resolve a DATABASE_URL into the absolute path of the SQLite file.
 *
 * @param {string} databaseUrl - The DATABASE_URL, e.g. "file:./shop.db".
 * @param {object} [options]
 * @param {string} [options.baseDir] - The directory a relative path is
 *   resolved against. Defaults to the backend root.
 * @returns {string} The absolute path of the database file.
 */
export function resolveDatabaseFilePath(databaseUrl, options = {}) {
  const baseDir = options.baseDir ? path.resolve(options.baseDir) : BACKEND_ROOT;
  const raw = String(databaseUrl ?? '').trim();

  if (!raw) {
    throw new Error('DATABASE_URL is not set.');
  }
  if (!raw.startsWith('file:')) {
    throw new Error(
      `Only a local "file:" DATABASE_URL is supported (received ${describeDatabaseUrl(raw)}).`,
    );
  }

  let rest = raw.slice('file:'.length);
  // "file:///abs/path" and "file://./relative" both carry two leading slashes
  // that are not part of the path.
  if (rest.startsWith('//')) rest = rest.slice(2);
  if (!rest) {
    throw new Error('The DATABASE_URL does not contain a file path.');
  }

  let decoded = rest;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    // A path that is not valid percent-encoding is used as it is.
    decoded = rest;
  }

  if (path.isAbsolute(decoded)) {
    return path.normalize(decoded);
  }
  return path.resolve(baseDir, decoded);
}

/**
 * The sidecar files SQLite may keep next to a database file.
 * They belong to the database and must never be mixed with another one.
 */
export function sqliteSidecarPaths(databasePath) {
  return [
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`,
  ];
}

export default {
  BACKEND_ROOT,
  resolveDatabaseFilePath,
  describeDatabaseUrl,
  sqliteSidecarPaths,
};
