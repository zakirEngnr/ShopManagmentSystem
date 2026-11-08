import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as reportController from '../controllers/report.controller.js';

const router = Router();

router.get('/daily', requireAuth, reportController.daily);
router.get('/pnl', requireAuth, reportController.pnl);
router.get('/top-products', requireAuth, reportController.topProducts);
router.get('/low-stock', requireAuth, reportController.lowStock);
router.get('/expiring-soon', requireAuth, reportController.expiringSoon);

export default router;

