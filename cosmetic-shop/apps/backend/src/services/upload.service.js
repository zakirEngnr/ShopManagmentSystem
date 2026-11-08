import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { IMAGE_NAME_RE } from '../middleware/upload.js';

const backendDir = path.resolve(import.meta.dirname, '..', '..');
const shopDbName = 'shop.db';
const win32 = process.platform === 'win32';

// Names tolerated inside an existing upload directory, besides image files.
const TOLERATED_NAMES = new Set(['.gitkeep', '.DS_Store', 'Thumbs.db', 'desktop.ini']);
const IMAGE_TMP_RE = new RegExp(IMAGE_NAME_RE.source.slice(0, -1) + '\\.tmp$');

function norm(p) {
  return win32 ? String(p).toLowerCase() : p;
}

function isAncestorOf(ancestor, descendant) {
  return (
    descendant === ancestor || descendant.startsWith(ancestor + path.sep)
  );
}

/**
 * Resolve the deepest existing ancestor of `target`, realpath it (defeating
 * symlink/junction aliases), then re-attach the remaining segments.
 * Returns the normalized target path when no ancestor exists.
 */
function canonicalize(target) {
  let cursor = path.resolve(target);
  let existing = null;
  while (true) {
    try {
      fs.statSync(cursor);
      existing = cursor;
      break;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (existing === null) return path.normalize(target);
  const real = fs.realpathSync(existing);
  const rel = path.relative(existing, path.resolve(target));
  return path.join(real, rel);
}

function isAllowedEntry(name) {
  const check = win32 ? name.toLowerCase() : name;
  if (IMAGE_NAME_RE.test(check)) return true;
  if (IMAGE_TMP_RE.test(check)) return true;
  if (TOLERATED_NAMES.has(check)) return true;
  return false;
}

/**
 * Resolve the upload directory from env.UPLOAD_DIR, relative to BACKEND
 * (never cwd). Refuse dangerous locations.
 *
 * `raw` defaults to env.UPLOAD_DIR; `opts.backendDir` and `opts.dbUrl` are
 * accepted so the refusal rules can be exercised directly in tests without
 * mutating frozen env. `opts.dbUrl` defaults to process.env.DATABASE_URL;
 * relative database paths are assumed to resolve against BACKEND.
 */
export function resolveUploadDir(raw = env.UPLOAD_DIR, opts = {}) {
  const { backendDir: optBackendDir = backendDir, dbUrl = process.env.DATABASE_URL } = opts;
  const resolved = canonicalize(path.resolve(optBackendDir, String(raw)));

  const root = path.parse(resolved).root;
  if (norm(resolved) === norm(root)) {
    throw new Error('refusing to use the filesystem root as UPLOAD_DIR');
  }

  const homeDir = os.homedir();
  if (norm(resolved) === norm(homeDir)) {
    throw new Error('refusing to use the user home directory as UPLOAD_DIR');
  }

  // Equal to or an ancestor of BACKEND.
  const nBackend = norm(optBackendDir);
  if (norm(resolved) === nBackend || norm(optBackendDir).startsWith(norm(resolved) + path.sep)) {
    throw new Error('refusing to use the backend directory or its ancestor as UPLOAD_DIR');
  }

  // Equal to or an ancestor of the directory holding the database. The db
  // path comes from dbUrl (strip `file:`; relative paths resolve against
  // BACKEND) and BACKEND/shop.db is checked as well.
  const dbPathRaw = String(dbUrl).replace(/^file:/, '');
  const dbFile = path.isAbsolute(dbPathRaw)
    ? dbPathRaw
    : path.resolve(optBackendDir, dbPathRaw);
  const dbDir = path.dirname(dbFile);
  if (
    norm(resolved) === norm(dbDir) ||
    norm(dbDir).startsWith(norm(resolved) + path.sep)
  ) {
    throw new Error('refusing to use the database directory or its ancestor as UPLOAD_DIR');
  }
  const shopDbFile = path.resolve(optBackendDir, shopDbName);
  if (
    norm(resolved) === norm(path.dirname(shopDbFile)) ||
    norm(path.dirname(shopDbFile)).startsWith(norm(resolved) + path.sep)
  ) {
    throw new Error('refusing to use the shop.db directory or its ancestor as UPLOAD_DIR');
  }

  // Equal to or inside one of BACKEND's source folders.
  const rel = path.relative(optBackendDir, resolved);
  const top = rel.split(path.sep)[0];
  if (
    top === 'src' || top === 'prisma' || top === 'test' ||
    top === 'test-support' || top === 'node_modules'
  ) {
    throw new Error('refusing: UPLOAD_DIR is inside a backend source folder');
  }

  // Content allowlist: an existing directory may hold only image files,
  // their .tmp upload counterparts, and a few tolerated OS files.
  let entries;
  try {
    entries = fs.readdirSync(resolved);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return resolved;
    throw err;
  }
  for (const entry of entries) {
    if (isAllowedEntry(entry)) continue;
    throw new Error(`refusing: unexpected entry in UPLOAD_DIR: ${entry}`);
  }

  return resolved;
}

/**
 * Save an image buffer under a server-generated UUID name.
 * `ext` must be one of jpg | png | webp. Returns the filename (never a
 * client-supplied name).
 */
export function saveImage(buffer, ext) {
  const e = String(ext).toLowerCase();
  if (!/^(jpg|png|webp)$/.test(e)) {
    throw new Error(`unsupported image extension: ${ext}`);
  }
  const dir = resolveUploadDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = randomUUID() + '.' + e;
  const target = path.join(dir, name);
  const tmp = target + '.tmp';
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    let written = 0;
    while (written < buffer.length) {
      written += fs.writeSync(fd, buffer, written, buffer.length - written);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
  return name;
}

/**
 * Delete an image file by filename. Returns true when deleted, false when
 * absent (ENOENT). Only names matching IMAGE_NAME_RE inside the resolved dir
 * are ever touched; traversal/non-matching names return false.
 */
export function deleteImageFile(filename) {
  if (typeof filename !== 'string' || !IMAGE_NAME_RE.test(filename)) return false;
  const dir = resolveUploadDir();
  const target = path.join(dir, filename);
  if (path.dirname(target) !== dir) return false;
  try {
    fs.unlinkSync(target);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Best-effort delete that never throws. Logs ONE string using the filename
 * and err.code (never err.message, which can contain paths).
 */
export function deleteImageFileSilent(filename) {
  try {
    return deleteImageFile(filename);
  } catch (err) {
    logger.warn(`deleteImageFileSilent: ${filename} failed code=${err.code}`);
    return false;
  }
}

/**
 * Extract the stored filename from an /uploads/<name> URL path.
 * Returns null for anything else.
 */
export function imageUrlToFilename(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/^\/uploads\/(.+)$/);
  if (!m) return null;
  const name = m[1];
  return IMAGE_NAME_RE.test(name) ? name : null;
}
