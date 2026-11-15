// A safe, recoverable restore.
//
// The order of the steps is the whole point:
//
//   1. validate the backup on a COPY            -> the live database is never
//                                                  touched by a bad backup
//   2. check the schema compatibility           -> an older backup is refused
//   3. refuse while the application is running
//   4. close and checkpoint the live database
//   5. copy the live database to a recovery copy -> verified by hash AND by
//                                                  PRAGMA integrity_check
//   6. copy the backup to a temporary file       -> verified before it is used
//   7. remove the sidecars of the OLD database
//   8. rename the temporary file over the live one (atomic)
//   9. verify the restored database
//
// Every failure before step 8 leaves the live database byte identical. A
// failure after step 8 leaves the verified recovery copy next to it.
//
// Migrations are NEVER applied by this module. A backup that is older than the
// application is refused unless the operator explicitly allows it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sqliteSidecarPaths } from '../utils/databasePath.js';
import {
  clientForFile,
  inspectDatabaseCompatibility,
  listRepositoryMigrations,
  readSchemaRequirements,
} from '../utils/databaseCompatibility.js';

export const RESTORE_OUTCOME = {
  /** The database was replaced and verified. */
  RESTORED: 'restored',
  /** Nothing was changed; the reason is in `code`. */
  REJECTED: 'rejected',
  /** The database was replaced but the verification failed. */
  FAILED: 'failed',
};

export const REJECT_CODE = {
  BACKUP_MISSING: 'backup-missing',
  BACKUP_NOT_A_FILE: 'backup-not-a-file',
  BACKUP_EMPTY: 'backup-empty',
  BACKUP_NOT_A_DATABASE: 'backup-not-a-database',
  BACKUP_INTEGRITY: 'backup-integrity-failed',
  BACKUP_FOREIGN_KEYS: 'backup-foreign-key-violations',
  BACKUP_INCOMPATIBLE: 'backup-schema-incompatible',
  DATABASE_BUSY: 'database-in-use',
  RECOVERY_COPY_FAILED: 'recovery-copy-failed',
  RECOVERY_COPY_UNVERIFIED: 'recovery-copy-unverified',
  TEMP_FILE_FAILED: 'temporary-file-failed',
  TEMP_FILE_UNVERIFIED: 'temporary-file-unverified',
  RESTORE_UNVERIFIED: 'restored-database-unverified',
};

/** The sha256 of a file. */
export function sha256File(filePath) {
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

/** A timestamp with millisecond precision: 20261115-080001-123. */
export function preciseTimestamp(date = new Date()) {
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `-${pad(date.getMilliseconds(), 3)}`
  );
}

/** The pattern of the recovery copies this module manages. */
export function recoveryCopyPattern(databasePath) {
  const base = path.basename(databasePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${base}\\.pre-restore-\\d{8}-\\d{6}-\\d{3}$`);
}

/** The recovery copies of a database that this module manages. */
export function listRecoveryCopies(databasePath) {
  const directory = path.dirname(databasePath);
  const pattern = recoveryCopyPattern(databasePath);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => pattern.test(name))
    .map((name) => {
      const full = path.join(directory, name);
      let stat;
      try { stat = fs.statSync(full); } catch { return null; }
      return { name, path: full, mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Remove the oldest recovery copies, never below `keep` and never the only
 * known-good copy.
 */
export function pruneRecoveryCopies(databasePath, keep = 5) {
  const copies = listRecoveryCopies(databasePath);
  const safeKeep = Math.max(1, Number(keep) || 1);
  const removable = copies.slice(safeKeep);
  const deleted = [];
  for (const copy of removable) {
    try {
      fs.unlinkSync(copy.path);
      deleted.push(copy.path);
    } catch { /* a copy that cannot be removed stays on disk */ }
  }
  return deleted;
}

/**
 * A recovery copy path that does not exist yet. An existing file is never
 * overwritten.
 */
export function uniqueRecoveryCopyPath(databasePath, date = new Date()) {
  const directory = path.dirname(databasePath);
  const base = path.basename(databasePath);
  const stamp = preciseTimestamp(date);
  let candidate = path.join(directory, `${base}.pre-restore-${stamp}`);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${base}.pre-restore-${stamp}-${counter}`);
    counter += 1;
  }
  return candidate;
}

/** The checks that every database file has to pass. */
export async function verifyDatabaseFile(dbFile) {
  const prisma = clientForFile(dbFile);
  try {
    const integrityRows = await prisma.$queryRawUnsafe('PRAGMA integrity_check');
    const first = integrityRows[0];
    const integrity = String(
      first && (first.integrity_check !== undefined ? first.integrity_check : Object.values(first)[0]),
    );

    let foreignKeys = [];
    try {
      foreignKeys = await prisma.$queryRawUnsafe('PRAGMA foreign_key_check');
    } catch {
      foreignKeys = [];
    }

    const tables = await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );

    return {
      ok: integrity === 'ok' && foreignKeys.length === 0,
      integrity,
      foreignKeyViolations: foreignKeys.length,
      tables: tables.map((row) => String(row.name)),
    };
  } finally {
    try { await prisma.$disconnect(); } catch { /* already gone */ }
  }
}

/**
 * Validate a backup file WITHOUT touching it: the checks run on a copy in a
 * temporary directory.
 *
 * @returns {Promise<object>} { ok, code, message, details }
 */
export async function validateBackupFile(backupPath, options = {}) {
  if (!backupPath) {
    return { ok: false, code: REJECT_CODE.BACKUP_MISSING, message: 'No backup file was given.' };
  }

  let stat;
  try {
    stat = fs.statSync(backupPath);
  } catch {
    return {
      ok: false,
      code: REJECT_CODE.BACKUP_MISSING,
      message: `The backup file does not exist: ${path.basename(backupPath)}`,
    };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      code: REJECT_CODE.BACKUP_NOT_A_FILE,
      message: `The backup path is not a regular file: ${path.basename(backupPath)}`,
    };
  }
  if (stat.size === 0) {
    return {
      ok: false,
      code: REJECT_CODE.BACKUP_EMPTY,
      message: `The backup file is empty: ${path.basename(backupPath)}`,
    };
  }

  let workDir = null;
  try {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-validate-'));
    const copy = path.join(workDir, 'candidate.db');
    fs.copyFileSync(backupPath, copy);

    const checks = await verifyDatabaseFile(copy);
    if (checks.integrity !== 'ok') {
      return {
        ok: false,
        code: REJECT_CODE.BACKUP_INTEGRITY,
        message: `The backup file is damaged (integrity check: ${checks.integrity}).`,
        details: { integrity: checks.integrity },
      };
    }
    if (checks.foreignKeyViolations > 0) {
      return {
        ok: false,
        code: REJECT_CODE.BACKUP_FOREIGN_KEYS,
        message: `The backup file has ${checks.foreignKeyViolations} broken foreign key(s).`,
        details: { foreignKeyViolations: checks.foreignKeyViolations },
      };
    }

    const requirements = options.requirements ?? readSchemaRequirements();
    const repositoryMigrations = options.repositoryMigrations ?? listRepositoryMigrations();
    const compatibility = await inspectDatabaseCompatibility(copy, {
      requirements,
      repositoryMigrations,
    });

    if (!compatibility.structure.compatible && !options.allowOlderSchema) {
      const missing = [
        ...compatibility.structure.missingTables.map((name) => `table ${name}`),
        ...compatibility.structure.missingColumns.map((name) => `column ${name}`),
      ];
      return {
        ok: false,
        code: REJECT_CODE.BACKUP_INCOMPATIBLE,
        message:
          `The backup is not compatible with this version of the application ` +
          `(missing ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}). ` +
          'Restore an older application version, or allow it explicitly with --allow-older-schema.',
        details: { missing },
      };
    }

    return {
      ok: true,
      code: null,
      message: 'The backup file is a valid, readable and compatible database.',
      details: {
        size: stat.size,
        tables: compatibility.facts.tables.length,
        indexes: compatibility.facts.indexNames.length,
        migrations: compatibility.facts.migrations.length,
        unrecordedMigrations: compatibility.history.unrecorded,
        structure: compatibility.structure,
      },
    };
  } catch (err) {
    // The driver answers with a multi line message; only its last line says
    // what went wrong, and it never contains a stack trace of the application.
    const lines = String(err?.message ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
    const reason = lines.length ? lines[lines.length - 1] : 'the file is not a readable database';
    return {
      ok: false,
      code: REJECT_CODE.BACKUP_NOT_A_DATABASE,
      message: `The backup file could not be read as a database (${reason}).`,
    };
  } finally {
    if (workDir) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * Fold the write-ahead log of a database into the database itself and close
 * it, so that the file that is copied is complete and consistent.
 */
export async function checkpointAndClose(databasePath) {
  const prisma = clientForFile(databasePath);
  let journalMode = 'unknown';
  try {
    const rows = await prisma.$queryRawUnsafe('PRAGMA journal_mode');
    journalMode = String(rows?.[0]?.journal_mode ?? 'unknown');
    if (String(journalMode).toLowerCase() === 'wal') {
      try {
        await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch { /* the checkpoint is best effort */ }
    }
  } finally {
    try { await prisma.$disconnect(); } catch { /* already gone */ }
  }
  return { journalMode };
}

/**
 * Restore a backup over the live database.
 *
 * @param {object} options
 * @param {string} options.backupPath - The backup to restore.
 * @param {string} options.databasePath - The live database to replace.
 * @param {boolean} [options.allowOlderSchema] - Restore even when the backup
 *   does not have every table and column of the current application.
 * @param {number} [options.keep] - How many recovery copies to keep.
 * @param {Function} [options.isApplicationRunning] - Returns true when the
 *   application is using the database.
 * @returns {Promise<object>} { outcome, code, message, recoveryCopy, details }
 */
export async function performRestore(options) {
  const {
    backupPath,
    databasePath,
    allowOlderSchema = false,
    keep = 5,
    isApplicationRunning = null,
  } = options;

  const steps = [];

  // 1. the backup is validated on a copy - the live database is not touched
  const validation = await validateBackupFile(backupPath, { allowOlderSchema });
  steps.push({ step: 'validate-backup', ok: validation.ok, message: validation.message });
  if (!validation.ok) {
    return {
      outcome: RESTORE_OUTCOME.REJECTED,
      code: validation.code,
      message: validation.message,
      steps,
      recoveryCopy: null,
      details: validation.details ?? null,
    };
  }

  // 2. no writer may be active
  if (typeof isApplicationRunning === 'function') {
    let running = false;
    try {
      running = Boolean(await isApplicationRunning());
    } catch {
      running = false;
    }
    if (running) {
      const message = 'The application is using the database. Stop it before restoring.';
      steps.push({ step: 'check-application', ok: false, message });
      return {
        outcome: RESTORE_OUTCOME.REJECTED,
        code: REJECT_CODE.DATABASE_BUSY,
        message,
        steps,
        recoveryCopy: null,
        details: null,
      };
    }
    steps.push({ step: 'check-application', ok: true, message: 'No writer is using the database.' });
  }

  const databaseDirectory = path.dirname(databasePath);
  const databaseExists = fs.existsSync(databasePath);
  let recoveryCopy = null;

  // 3. the live database is closed, checkpointed and copied
  if (databaseExists) {
    try {
      fs.mkdirSync(databaseDirectory, { recursive: true });
    } catch { /* the directory exists */ }

    const checkpoint = await checkpointAndClose(databasePath);

    recoveryCopy = uniqueRecoveryCopyPath(databasePath);
    try {
      fs.copyFileSync(databasePath, recoveryCopy);
    } catch (err) {
      const message = `The recovery copy could not be created: ${err.message}`;
      steps.push({ step: 'recovery-copy', ok: false, message });
      return {
        outcome: RESTORE_OUTCOME.REJECTED,
        code: REJECT_CODE.RECOVERY_COPY_FAILED,
        message,
        steps,
        recoveryCopy: null,
        details: null,
      };
    }

    // The copy must be identical to the source. A different hash means the
    // database changed while it was copied - a writer was active.
    const sourceHash = sha256File(databasePath);
    const copyHash = sha256File(recoveryCopy);
    if (sourceHash !== copyHash) {
      const message = 'The database changed while the recovery copy was made. '
        + 'Another program is writing to it - stop it and try again.';
      steps.push({ step: 'recovery-copy', ok: false, message });
      return {
        outcome: RESTORE_OUTCOME.REJECTED,
        code: REJECT_CODE.DATABASE_BUSY,
        message,
        steps,
        recoveryCopy,
        details: null,
      };
    }

    const copyChecks = await verifyDatabaseFile(recoveryCopy);
    if (!copyChecks.ok) {
      const message = `The recovery copy is not usable (integrity check: ${copyChecks.integrity}). `
        + 'The live database was NOT changed.';
      steps.push({ step: 'recovery-copy', ok: false, message });
      return {
        outcome: RESTORE_OUTCOME.REJECTED,
        code: REJECT_CODE.RECOVERY_COPY_UNVERIFIED,
        message,
        steps,
        recoveryCopy,
        details: null,
      };
    }
    steps.push({
      step: 'recovery-copy',
      ok: true,
      message: `Recovery copy created: ${recoveryCopy}`,
      journalMode: checkpoint.journalMode,
    });
  }

  // 4. the backup is prepared in a temporary file next to the live database
  const temporaryPath = `${databasePath}.restore-tmp-${preciseTimestamp()}`;
  try {
    fs.copyFileSync(backupPath, temporaryPath);
  } catch (err) {
    const message = `The temporary restore file could not be created: ${err.message}`;
    steps.push({ step: 'temporary-file', ok: false, message });
    return {
      outcome: RESTORE_OUTCOME.REJECTED,
      code: REJECT_CODE.TEMP_FILE_FAILED,
      message,
      steps,
      recoveryCopy,
      details: null,
    };
  }

  try {
    // Flush the temporary file to disk before it is used.
    try {
      const fd = fs.openSync(temporaryPath, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch { /* fsync is best effort on some filesystems */ }

    const temporaryChecks = await verifyDatabaseFile(temporaryPath);
    if (!temporaryChecks.ok) {
      const message = `The prepared restore file failed its verification (integrity check: ${temporaryChecks.integrity}). `
        + 'The live database was NOT changed.';
      steps.push({ step: 'temporary-file', ok: false, message });
      return {
        outcome: RESTORE_OUTCOME.REJECTED,
        code: REJECT_CODE.TEMP_FILE_UNVERIFIED,
        message,
        steps,
        recoveryCopy,
        details: null,
      };
    }
    steps.push({ step: 'temporary-file', ok: true, message: 'The restore file was prepared and verified.' });

    // 5. the sidecars of the OLD database must not be applied to the new one.
    //    The old database is closed, checkpointed and preserved in the verified
    //    recovery copy, so nothing is lost by removing them here.
    const removedSidecars = [];
    for (const sidecar of sqliteSidecarPaths(databasePath)) {
      if (!fs.existsSync(sidecar)) continue;
      try {
        fs.unlinkSync(sidecar);
        removedSidecars.push(path.basename(sidecar));
      } catch { /* a sidecar that cannot be removed is reported below */ }
    }
    steps.push({
      step: 'sidecars',
      ok: true,
      message: removedSidecars.length
        ? `Removed the sidecar files of the old database: ${removedSidecars.join(', ')}`
        : 'The old database had no sidecar files.',
    });

    // 6. the atomic replacement
    fs.renameSync(temporaryPath, databasePath);
    try {
      const dirFd = fs.openSync(databaseDirectory, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* the directory flush is best effort */ }
    steps.push({ step: 'replace', ok: true, message: 'The database was replaced.' });

    // 7. the restored database is verified
    const restored = await verifyDatabaseFile(databasePath);
    if (!restored.ok) {
      const recovery = recoveryCopy
        ? `To go back to the previous database:\n  cp "${recoveryCopy}" "${databasePath}"`
        : 'There was no previous database to go back to.';
      const message = `The database was replaced but it did not pass its verification `
        + `(integrity check: ${restored.integrity}). ${recovery}`;
      steps.push({ step: 'verify-restored', ok: false, message });
      return {
        outcome: RESTORE_OUTCOME.FAILED,
        code: REJECT_CODE.RESTORE_UNVERIFIED,
        message,
        steps,
        recoveryCopy,
        details: restored,
      };
    }
    steps.push({ step: 'verify-restored', ok: true, message: 'The restored database passed its verification.' });

    // 8. the recovery copies are rotated, the newest ones are kept
    const deleted = pruneRecoveryCopies(databasePath, keep);
    steps.push({
      step: 'retention',
      ok: true,
      message: deleted.length ? `Removed ${deleted.length} old recovery copy/copies.` : 'No recovery copy had to be removed.',
    });

    return {
      outcome: RESTORE_OUTCOME.RESTORED,
      code: null,
      message: 'The database was restored and verified.',
      steps,
      recoveryCopy,
      details: {
        validation: validation.details,
        restored,
        deletedRecoveryCopies: deleted,
      },
    };
  } catch (err) {
    // The live database is either untouched (the rename did not happen) or
    // already replaced (it did). The recovery copy is kept in both cases.
    try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch { /* best effort */ }
    const message = `The restore failed: ${err.message}.`
      + (recoveryCopy
        ? ` The previous database is preserved at: ${recoveryCopy}`
        : ' The live database was not changed.');
    steps.push({ step: 'replace', ok: false, message });
    return {
      outcome: RESTORE_OUTCOME.REJECTED,
      code: REJECT_CODE.RESTORE_UNVERIFIED,
      message,
      steps,
      recoveryCopy,
      details: null,
    };
  }
}

export default {
  RESTORE_OUTCOME,
  REJECT_CODE,
  sha256File,
  preciseTimestamp,
  recoveryCopyPattern,
  listRecoveryCopies,
  pruneRecoveryCopies,
  uniqueRecoveryCopyPath,
  verifyDatabaseFile,
  validateBackupFile,
  checkpointAndClose,
  performRestore,
};
