// The lock that protects the backup directory.
//
// The backup service runs in the backend process, but a backup can also be
// created by a second backend process, by a script or by the scheduler of
// another instance. An in-memory flag cannot protect against that, so the
// lock is a FILE in the backup directory that is created exclusively.
//
// The lock is only broken when its owner is provably gone: a lock is never
// removed because it looks old.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BACKUP_LOCK_FILENAME = '.backup.lock';

/** Is the process with this id alive? */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return err.code === 'EPERM';
  }
}

/** The content of a lock file. */
export function readLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Take the backup lock.
 *
 * @param {object} options
 * @param {string} options.directory - The backup directory.
 * @param {number} [options.pid] - The owner of the lock.
 * @returns {object} { path, release }
 * @throws When another live process holds the lock.
 */
export function acquireBackupLock(options = {}) {
  const directory = options.directory;
  const pid = options.pid ?? process.pid;
  const lockPath = path.join(directory, BACKUP_LOCK_FILENAME);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      // "wx" fails when the file exists: the creation is exclusive.
      fd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw Object.assign(new Error(`The backup lock could not be created: ${err.message}`), { status: 500 });
      }

      const holder = readLock(lockPath);
      const holderPid = holder && Number.isInteger(holder.pid) ? holder.pid : null;

      if (holderPid === null) {
        // The lock cannot be read: nobody can prove that its owner is gone,
        // so the lock is NOT broken. The operator has to remove it.
        throw Object.assign(
          new Error(
            `The backup lock ${lockPath} cannot be read. `
            + 'If no backup is running, remove that file and try again.',
          ),
          { status: 500, code: 'backup-lock-unreadable' },
        );
      }

      if (isProcessAlive(holderPid)) {
        throw Object.assign(
          new Error(
            `Another backup is already running (process ${holderPid}). `
            + 'Wait for it to finish, then try again.',
          ),
          { status: 409, code: 'backup-in-progress', holderPid },
        );
      }

      // The owner is gone: the lock is stale and may be broken.
      try {
        fs.unlinkSync(lockPath);
      } catch (err) {
        throw Object.assign(
          new Error(`A stale backup lock could not be removed: ${err.message}`),
          { status: 500, code: 'backup-lock-stale' },
        );
      }
      continue;
    }

    const content = JSON.stringify({
      pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
    });
    try {
      fs.writeSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }

    let released = false;
    return {
      path: lockPath,
      pid,
      release() {
        if (released) return false;
        released = true;
        // Only the owner may release the lock.
        const current = readLock(lockPath);
        if (current && current.pid !== pid) return false;
        try {
          fs.unlinkSync(lockPath);
          return true;
        } catch {
          return false;
        }
      },
    };
  }

  throw Object.assign(new Error('The backup lock could not be taken.'), { status: 500 });
}

/** Is the backup lock currently held by a live process? */
export function isBackupLocked(directory) {
  const lockPath = path.join(directory, BACKUP_LOCK_FILENAME);
  if (!fs.existsSync(lockPath)) return false;
  const holder = readLock(lockPath);
  if (!holder || !Number.isInteger(holder.pid)) return true; // unreadable: assume it is held
  return isProcessAlive(holder.pid);
}

export default {
  BACKUP_LOCK_FILENAME,
  isProcessAlive,
  readLock,
  acquireBackupLock,
  isBackupLocked,
};
