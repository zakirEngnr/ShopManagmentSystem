import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as stockController from '../controllers/stock.controller.js';

const router = Router();
router.post('/', requireAuth, stockController.create);
router.get('/', requireAuth, stockController.list);
router.get('/product/:id', requireAuth, stockController.getForProduct);

export default router;
