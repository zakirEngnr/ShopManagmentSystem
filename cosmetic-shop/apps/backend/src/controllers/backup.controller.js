import { createBackup as createBackupService, listBackups as listBackupsService } from '../services/backup.service.js';

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

export default { listBackups, createBackup };
