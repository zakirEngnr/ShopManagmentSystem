import fs from 'node:fs';
import path from 'node:path';

import {
  createBackup as createBackupService,
  listBackups as listBackupsService,
  BACKUP_FILE_NAME_REGEX,
  BACKUP_DIR,
} from '../services/backup.service.js';

export async function listBackups(req, res, next) {
  try {
    const backups = await listBackupsService();
    res.json({ ok: true, backups });
  } catch (err) {
    next(err);
  }
}

export async function createBackup(req, res, next) {
  try {
    const backup = await createBackupService();
    res.status(201).json({ ok: true, backup });
  } catch (err) {
    next(err);
  }
}

/**
 * Download one backup file.
 *
 * The file name is restricted to the names the backup service uses, the
 * resolved file must stay inside the backup directory and the file must
 * exist. No path of the file system is ever returned to the caller.
 */
export async function downloadBackup(req, res, next) {
  try {
    const filename = String(req.params?.filename ?? '');

    if (!BACKUP_FILE_NAME_REGEX.test(filename)) {
      return res.status(400).json({
        ok: false,
        error: { message: 'That is not a valid backup file name.' },
      });
    }

    const backupDirectory = path.resolve(BACKUP_DIR);
    const fullPath = path.resolve(path.join(backupDirectory, filename));
    if (path.dirname(fullPath) !== backupDirectory) {
      return res.status(400).json({
        ok: false,
        error: { message: 'That is not a valid backup file name.' },
      });
    }

    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      return res.status(404).json({
        ok: false,
        error: { message: 'That backup file does not exist.' },
      });
    }
    if (!stat.isFile()) {
      return res.status(404).json({
        ok: false,
        error: { message: 'That backup file does not exist.' },
      });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'no-store');
    return res.download(fullPath, filename, (err) => {
      if (err && !res.headersSent) next(err);
    });
  } catch (err) {
    next(err);
  }
}

export default { listBackups, createBackup, downloadBackup };
