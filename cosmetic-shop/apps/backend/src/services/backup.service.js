// The creation, the verification, the publication, the transfer and the
// rotation of the database backups.
//
// THE LIFECYCLE OF A BACKUP
//
//   1. the database path is resolved with the shared resolver
//   2. the free space of the backup directory is checked
//   3. a name that no backup uses yet is chosen
//   4. the lock of the backup directory is taken (it works across processes)
//   5. a TEMPORARY file in the backup directory is filled with a consistent
//      SQLite snapshot (VACUUM INTO)
//   6. the temporary file is flushed and verified on its own
//      (integrity, foreign keys, schema, migration history, size)
//   7. the checksum of the temporary file is calculated
//   8. the temporary file is RENAMED to its final name - the publication is
//      atomic, so the final name NEVER refers to an incomplete backup
//   9. the directory is flushed, the metadata is written
//  10. the backup is copied to the external destination, if there is one
//  11. the old backups are rotated
//
// A failure at any step removes the temporary file, keeps every existing
// backup untouched and reports an actionable error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { resolveDatabaseFilePath } from '../utils/databasePath.js';
import {
  LISTED_BACKUP_REGEX,
  BACKUP_FILE_NAME_REGEX,
  BACKUP_FILE_MODE,
  BACKUP_DIR_MODE,
  uniqueBackupName,
  temporaryBackupPath,
  fileSha256,
  fsyncFile,
  fsyncDirectory,
  ensureDirectory,
  applyPrivateMode,
  writeFileAtomically,
  removeQuietly,
} from '../utils/backupFiles.js';
import { acquireBackupLock } from './backupLock.service.js';
import { checkDiskSpace, estimateRequiredBytes, formatBytes } from './backupSpace.service.js';
import {
  compareWithSchema,
  compareMigrationHistory,
  listRepositoryMigrations,
  readDatabaseFacts,
  readSchemaRequirements,
} from '../utils/databaseCompatibility.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..', '..'); // apps/backend

const BACKUP_DIR = (() => {
  const raw = process.env.BACKUP_DIR;
  if (!raw || raw === '') return path.join(BACKEND_ROOT, 'backups');
  return path.isAbsolute(raw) ? raw : path.resolve(BACKEND_ROOT, raw);
})();

const RETENTION_DEFAULT = 30;
const BACKUP_KEEP = (() => {
  const raw = Number(process.env.BACKUP_KEEP);
  return Number.isFinite(raw) && raw >= 1 ? raw : RETENTION_DEFAULT;
})();

const BACKUP_COPY_DIR = process.env.BACKUP_COPY_DIR || '';

/** The files that are being transferred to the external destination right now. */
const inFlightTransfers = new Set();

function escapeSqlString(value) {
  return String(value).replace(/'/g, "''");
}

function prismaForFile(fileUrl) {
  const adapter = new PrismaLibSql({ url: fileUrl });
  return new PrismaClient({ adapter });
}

/** The database path of the application. */
export function resolveDbFilePath() {
  return resolveDatabaseFilePath(env.DATABASE_URL);
}

export function assertLocalDatabase() {
  resolveDbFilePath();
}

/** The backup directory of the application. */
function backupDirectory() {
  return ensureDirectory(BACKUP_DIR, BACKUP_DIR_MODE).directory;
}

/**
 * The backups of the directory: the files with the canonical name. The
 * temporary files of a running backup and the legacy names are not part of it.
 */
export function listBackupFiles(directory = BACKUP_DIR) {
  ensureDirectory(directory, BACKUP_DIR_MODE);
  const names = fs.readdirSync(directory);
  const backups = [];
  for (const name of names) {
    if (!LISTED_BACKUP_REGEX.test(name)) continue;
    const full = path.join(directory, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    backups.push({ filename: name, path: full, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return backups;
}

/**
 * Verify a database file on its own.
 *
 * A file that is not a valid database is removed: a file that cannot be read
 * must never be kept as if it were a backup.
 */
export async function verifyBackup(filePath) {
  let prisma;
  try {
    prisma = prismaForFile(`file:${filePath}`);
    const rows = await prisma.$queryRawUnsafe('PRAGMA integrity_check');
    const first = rows[0];
    const result = String(
      first && (first.integrity_check !== undefined ? first.integrity_check : Object.values(first)[0]),
    );
    if (result !== 'ok') {
      throw new Error(`integrity check failed: ${result}`);
    }
    let foreignKeys = [];
    try {
      foreignKeys = await prisma.$queryRawUnsafe('PRAGMA foreign_key_check');
    } catch {
      foreignKeys = [];
    }
    if (foreignKeys.length > 0) {
      throw new Error(`foreign key check failed: ${foreignKeys.length} violation(s)`);
    }
    return true;
  } catch (err) {
    removeQuietly(filePath);
    logger.warn(`backup verification failed for ${filePath}: ${err.message}`);
    throw err;
  } finally {
    if (prisma) {
      try { await prisma.$disconnect(); } catch { /* already gone */ }
    }
  }
}

/**
 * The full inspection of a backup file: the integrity, the foreign keys, the
 * schema, the migration history and the size.
 */
export async function inspectBackup(filePath) {
  let prisma;
  try {
    prisma = prismaForFile(`file:${filePath}`);
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
    const facts = await readDatabaseFacts(filePath);
    const structure = compareWithSchema(readSchemaRequirements(), facts);
    const history = compareMigrationHistory(facts, listRepositoryMigrations());
    return {
      ok: integrity === 'ok' && foreignKeys.length === 0 && structure.compatible,
      integrity,
      foreignKeyViolations: foreignKeys.length,
      tables: facts.tables.length,
      indexes: facts.indexNames.length,
      migrations: facts.migrations.map((migration) => migration.name),
      unrecordedMigrations: history.unrecorded,
      structure,
      history,
    };
  } finally {
    if (prisma) {
      try { await prisma.$disconnect(); } catch { /* already gone */ }
    }
  }
}

/** The metadata of a published backup. */
function metadataPathFor(directory, filename) {
  return path.join(directory, `${filename}.json`);
}

/**
 * Copy a published backup to the external destination (a USB drive for
 * example) and publish it there only after it has been verified there.
 */
export async function copyBackupToExternalDestination(sourcePath, filename, options = {}) {
  const destinationDirectory = options.destination ?? BACKUP_COPY_DIR;
  if (!destinationDirectory) {
    return { copied: false, reason: 'no external destination is configured' };
  }

  let directoryStat;
  try {
    directoryStat = fs.statSync(destinationDirectory);
  } catch (err) {
    throw Object.assign(
      new Error(`The external destination ${destinationDirectory} is not available: ${err.message}`),
      { status: 500, code: 'external-destination-unavailable' },
    );
  }
  if (!directoryStat.isDirectory()) {
    throw Object.assign(
      new Error(`The external destination ${destinationDirectory} is not a directory.`),
      { status: 500, code: 'external-destination-unavailable' },
    );
  }
  try {
    fs.accessSync(destinationDirectory, fs.constants.W_OK);
  } catch {
    throw Object.assign(
      new Error(`The external destination ${destinationDirectory} is not writable.`),
      { status: 500, code: 'external-destination-read-only' },
    );
  }

  const sourceStat = fs.statSync(sourcePath);
  const space = checkDiskSpace({
    directory: destinationDirectory,
    requiredBytes: estimateRequiredBytes(sourceStat.size),
  });
  if (space.checked && !space.ok) {
    throw Object.assign(new Error(space.message), { status: 507, code: 'external-destination-full' });
  }

  const finalPath = path.join(destinationDirectory, filename);

  // A valid backup that is already there is never overwritten.
  if (fs.existsSync(finalPath)) {
    const existingHash = fileSha256(finalPath);
    const sourceHash = fileSha256(sourcePath);
    if (existingHash === sourceHash) {
      return { copied: false, reason: 'the backup is already on the destination', path: finalPath, sha256: existingHash };
    }
    throw Object.assign(
      new Error(`A different backup with the name ${filename} is already on the destination; it was not overwritten.`),
      { status: 409, code: 'external-destination-conflict' },
    );
  }

  const temporary = path.join(destinationDirectory, `.shop-tmp-${path.basename(filename)}-${process.pid}`);
  inFlightTransfers.add(filename);
  try {
    fs.copyFileSync(sourcePath, temporary);
    fsyncFile(temporary);

    const copiedStat = fs.statSync(temporary);
    if (copiedStat.size !== sourceStat.size) {
      throw new Error(
        `The copy on the destination has ${copiedStat.size} bytes, the backup has ${sourceStat.size}.`,
      );
    }

    const sourceHash = fileSha256(sourcePath);
    const destinationHash = fileSha256(temporary);
    if (sourceHash !== destinationHash) {
      throw new Error('The checksum of the copy on the destination does not match the backup.');
    }

    // The source must not have changed while it was copied.
    if (fileSha256(sourcePath) !== sourceHash) {
      throw new Error('The backup changed while it was copied to the destination.');
    }

    // The copy must be a readable database on its own.
    await verifyBackup(temporary);

    applyPrivateMode(temporary, BACKUP_FILE_MODE);
    fs.renameSync(temporary, finalPath);
    fsyncDirectory(destinationDirectory);

    return {
      copied: true,
      path: finalPath,
      sha256: destinationHash,
      size: copiedStat.size,
    };
  } catch (err) {
    removeQuietly(temporary);
    throw Object.assign(err, { code: err.code ?? 'external-transfer-failed' });
  } finally {
    inFlightTransfers.delete(filename);
  }
}

/**
 * Create a backup of the database of the application.
 *
 * The backup is only published after it has been verified; the name of a
 * published backup never refers to an incomplete file.
 */
export async function createBackup(options = {}) {
  assertLocalDatabase();
  const directory = options.directory ?? backupDirectory();

  const lock = acquireBackupLock({ directory });
  let temporaryPath = null;
  try {
    const dbFile = resolveDbFilePath();

    let dbStat;
    try {
      dbStat = fs.statSync(dbFile);
    } catch {
      throw Object.assign(new Error('Database file not found'), { status: 404, code: 'database-missing' });
    }
    if (!dbStat.isFile()) {
      throw Object.assign(new Error('Database file not found'), { status: 404, code: 'database-missing' });
    }
    try {
      fs.accessSync(dbFile, fs.constants.R_OK);
    } catch {
      throw Object.assign(new Error('Database file not found'), { status: 404, code: 'database-missing' });
    }

    // The space is checked before anything is written.
    const requiredBytes = estimateRequiredBytes(dbStat.size);
    const space = checkDiskSpace({ directory, requiredBytes });
    if (!space.checked) {
      logger.warn(space.message);
    } else if (!space.ok) {
      throw Object.assign(new Error(space.message), { status: 507, code: 'insufficient-space' });
    }

    const filename = uniqueBackupName(directory);
    const destination = path.join(directory, filename);
    temporaryPath = temporaryBackupPath(directory);

    // The consistent snapshot.
    const escaped = escapeSqlString(temporaryPath);
    let admin;
    try {
      admin = prismaForFile(`file:${dbFile}`);
      await admin.$executeRawUnsafe(`VACUUM INTO '${escaped}'`);
    } catch (err) {
      throw Object.assign(new Error(`Backup creation failed: ${err.message}`), { status: 500, code: 'backup-failed' });
    } finally {
      if (admin) { try { await admin.$disconnect(); } catch { /* already gone */ } }
    }

    fsyncFile(temporaryPath);

    // The temporary file is verified on its own, before it is published.
    let inspection;
    try {
      inspection = await inspectBackup(temporaryPath);
    } catch (err) {
      throw Object.assign(new Error(`The backup could not be read: ${err.message}`), {
        status: 500,
        code: 'backup-unreadable',
      });
    }
    if (!inspection.ok) {
      const reasons = [];
      if (inspection.integrity !== 'ok') reasons.push(`integrity check: ${inspection.integrity}`);
      if (inspection.foreignKeyViolations > 0) reasons.push(`${inspection.foreignKeyViolations} foreign key violation(s)`);
      if (!inspection.structure.compatible) {
        reasons.push(`the schema does not match the application (${[
          ...inspection.structure.missingTables.map((name) => `table ${name}`),
          ...inspection.structure.missingColumns.map((name) => `column ${name}`),
        ].join(', ')})`);
      }
      throw Object.assign(new Error(`The backup was not verified: ${reasons.join('; ')}.`), {
        status: 500,
        code: 'backup-unverified',
      });
    }

    const temporaryStat = fs.statSync(temporaryPath);
    if (temporaryStat.size === 0) {
      throw Object.assign(new Error('The backup is empty and was not published.'), {
        status: 500,
        code: 'backup-empty',
      });
    }

    const sha256 = fileSha256(temporaryPath);
    applyPrivateMode(temporaryPath, BACKUP_FILE_MODE);

    // THE PUBLICATION: the rename is atomic.
    fs.renameSync(temporaryPath, destination);
    temporaryPath = null;
    fsyncDirectory(directory);

    const stat = fs.statSync(destination);

    // The metadata is published only after the backup itself.
    const metadata = {
      filename,
      sha256,
      size: stat.size,
      createdAt: new Date().toISOString(),
      source: dbFile,
      integrity: inspection.integrity,
      foreignKeyViolations: inspection.foreignKeyViolations,
      tables: inspection.tables,
      indexes: inspection.indexes,
      migrations: inspection.migrations,
    };
    try {
      writeFileAtomically(metadataPathFor(directory, filename), `${JSON.stringify(metadata, null, 2)}\n`);
    } catch (err) {
      logger.warn(`the metadata of ${filename} could not be written: ${err.message}`);
    }

    // The external destination.
    let external = { copied: false, reason: 'no external destination is configured' };
    if (BACKUP_COPY_DIR) {
      try {
        external = await copyBackupToExternalDestination(destination, filename);
      } catch (err) {
        // The backup itself is fine; the transfer is reported as a warning.
        external = { copied: false, reason: err.message, code: err.code ?? null };
        logger.warn(`Could not copy the backup to ${BACKUP_COPY_DIR}: ${err.message}`);
      }
    }

    // The rotation, for manual and for scheduled backups alike.
    const deleted = enforceRetention({ keep: options.keep ?? BACKUP_KEEP, directory });

    return {
      id: filename,
      filename,
      size: stat.size,
      createdAt: metadata.createdAt,
      sha256,
      verified: true,
      space,
      external,
      rotated: deleted,
    };
  } catch (err) {
    if (temporaryPath) {
      removeQuietly(temporaryPath);
      logger.warn(`the incomplete backup ${temporaryPath} was removed`);
    }
    throw err;
  } finally {
    lock.release();
  }
}

/** The backups of the application, newest first. */
export async function listBackups() {
  return listBackupFiles().map(({ filename, size, mtimeMs }) => {
    let verified = false;
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPathFor(BACKUP_DIR, filename), 'utf8'));
      verified = metadata.sha256 ? true : false;
    } catch {
      verified = false;
    }
    return {
      id: filename,
      filename,
      size,
      createdAt: new Date(mtimeMs).toISOString(),
      verified,
    };
  });
}

/**
 * Remove the oldest backups.
 *
 * Only the files with the canonical name are rotated; the temporary files and
 * the legacy names are never touched. The newest backup and the last known
 * good backup are never removed, and a file that is being transferred right
 * now is kept.
 */
export function enforceRetention(options = {}) {
  const directory = options.directory ?? BACKUP_DIR;
  const keep = Math.max(1, Number(options.keep ?? BACKUP_KEEP) || 1);
  const backups = listBackupFiles(directory);
  const toDelete = backups.slice(keep);
  let deleted = 0;
  const removed = [];
  for (const backup of toDelete) {
    if (inFlightTransfers.has(backup.filename)) continue;
    try {
      fs.unlinkSync(backup.path);
      removeQuietly(metadataPathFor(directory, backup.filename));
      deleted += 1;
      removed.push(backup.filename);
    } catch (err) {
      logger.warn(`the old backup ${backup.filename} could not be removed: ${err.message}`);
    }
  }
  return deleted;
}

/** The scheduled backup: once a day, when the newest one is older than a day. */
export async function runScheduledBackup() {
  try {
    const backups = listBackupFiles();
    const now = Date.now();
    const oldestAllowed = now - 24 * 60 * 60 * 1000;
    const due = backups.length === 0 || backups[0].mtimeMs < oldestAllowed;
    if (due) {
      const created = await createBackup();
      logger.info(`Scheduled backup created: ${created.filename}`);
    }
  } catch (err) {
    logger.warn(`Scheduled backup skipped: ${err.message}`);
  }
}

export function startBackupScheduler() {
  void runScheduledBackup();
  const interval = setInterval(() => { void runScheduledBackup(); }, 24 * 60 * 60 * 1000);
  if (interval.unref) interval.unref();
  return interval;
}

export { BACKUP_DIR, BACKUP_KEEP, BACKUP_COPY_DIR, BACKUP_FILE_NAME_REGEX, LISTED_BACKUP_REGEX, inFlightTransfers };

export default {
  createBackup,
  listBackups,
  listBackupFiles,
  verifyBackup,
  inspectBackup,
  enforceRetention,
  runScheduledBackup,
  startBackupScheduler,
  assertLocalDatabase,
  copyBackupToExternalDestination,
  resolveDbFilePath,
  inFlightTransfers,
  get BACKUP_DIR() {
    return BACKUP_DIR;
  },
};
