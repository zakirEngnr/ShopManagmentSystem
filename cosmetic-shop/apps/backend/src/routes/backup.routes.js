import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import { listBackups, createBackup } from '../controllers/backup.controller.js';

const backupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: { message: 'Too many backup requests. Try again later.' } },
});

const router = Router();

router.get('/', requireAuth, backupLimiter, listBackups);
router.post('/', requireAuth, backupLimiter, createBackup);

export default router;
