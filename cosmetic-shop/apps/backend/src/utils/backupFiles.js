// Names, temporary files, hashes, synchronisation and permissions of the
// backup files.
//
// The rules of this module are the contract between the backup service, the
// retention, the listing, the download endpoint and the external transfer:
//
//   * a PUBLISHED backup is named  shop-YYYYMMDD-HHmmss[-mmm][-n].db
//   * a TEMPORARY file is named  .shop-tmp-<id>.db  and is never a backup
//   * the METADATA of a backup is named  <backup>.json
//   * the LEGACY names (shop-backup-<timestamp>.db) are kept, are not listed
//     and are never rotated
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** The backups the application lists and rotates. */
export const LISTED_BACKUP_REGEX = /^shop-\d{8}-\d{6}(?:-\d{3})?(?:-\d+)?\.db$/;

/** Every file name the download endpoint accepts (the listed ones and the legacy ones). */
export const BACKUP_FILE_NAME_REGEX = /^shop-(?:\d{8}-\d{6}(?:-\d{3})?(?:-\d+)?|backup-[A-Za-z0-9._-]+)\.db$/;

/** The temporary files of a backup that is being created. */
export const TEMPORARY_BACKUP_REGEX = /^\.shop-tmp-[A-Za-z0-9._-]+\.db$/;

/** The metadata file of a published backup. */
export const METADATA_SUFFIX = '.json';

/** The permissions of a backup file: only the owner may read it. */
export const BACKUP_FILE_MODE = 0o600;

/** The permissions of a backup directory that this application creates. */
export const BACKUP_DIR_MODE = 0o700;

const pad = (value, size = 2) => String(value).padStart(size, '0');

/** The timestamp of a backup name: YYYYMMDD-HHmmss. */
export function backupTimestamp(date = new Date()) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * A file name that no published backup uses yet.
 *
 * The timestamp has a millisecond precision and a random suffix is added when
 * the name is taken, so two processes can never plan the same name. The
 * existence is probed, the creation of the file is exclusive.
 */
export function uniqueBackupName(directory, date = new Date()) {
  const stamp = backupTimestamp(date);
  const millis = pad(date.getMilliseconds(), 3);
  const base = `shop-${stamp}-${millis}`;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const name = attempt === 0 ? `${base}.db` : `${base}-${attempt + 1}.db`;
    if (!fs.existsSync(path.join(directory, name))) return name;
  }
  throw new Error('no free backup file name could be found');
}

/** The temporary path of a backup that is being created. */
export function temporaryBackupPath(directory, id = crypto.randomBytes(6).toString('hex')) {
  return path.join(directory, `.shop-tmp-${id}.db`);
}

/** True when the file is a temporary artifact of a backup. */
export function isTemporaryBackupFile(filename) {
  return TEMPORARY_BACKUP_REGEX.test(filename);
}

/** The sha256 of a file. */
export function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Flush a file to the disk. Not every filesystem supports it. */
export function fsyncFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r+');
    fs.fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** Flush a directory to the disk. Not every filesystem supports it. */
export function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Create a directory if it does not exist.
 *
 * A directory that this application creates is only accessible by its owner.
 * An existing directory keeps its permissions: the application never changes
 * the permissions of a directory it did not create.
 */
export function ensureDirectory(directory, mode = BACKUP_DIR_MODE) {
  const existed = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true, mode });
  if (!existed) {
    try { fs.chmodSync(directory, mode); } catch { /* the filesystem may not allow it */ }
  }
  return { directory, created: !existed };
}

/** Restrict a file to its owner. */
export function applyPrivateMode(filePath, mode = BACKUP_FILE_MODE) {
  try {
    fs.chmodSync(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

/** Write a file atomically: into a temporary file, then a rename. */
export function writeFileAtomically(targetPath, content, mode = BACKUP_FILE_MODE) {
  const directory = path.dirname(targetPath);
  const temporary = path.join(directory, `.shop-tmp-${crypto.randomBytes(6).toString('hex')}.json`);
  fs.writeFileSync(temporary, content, { mode });
  applyPrivateMode(temporary, mode);
  fsyncFile(temporary);
  fs.renameSync(temporary, targetPath);
  fsyncDirectory(directory);
}

/** Remove a file and ignore every error. */
export function removeQuietly(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export default {
  LISTED_BACKUP_REGEX,
  BACKUP_FILE_NAME_REGEX,
  TEMPORARY_BACKUP_REGEX,
  METADATA_SUFFIX,
  BACKUP_FILE_MODE,
  BACKUP_DIR_MODE,
  backupTimestamp,
  uniqueBackupName,
  temporaryBackupPath,
  isTemporaryBackupFile,
  fileSha256,
  fsyncFile,
  fsyncDirectory,
  ensureDirectory,
  applyPrivateMode,
  writeFileAtomically,
  removeQuietly,
};
