import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as purchaseController from '../controllers/purchase.controller.js';

const router = Router();

router.get('/', requireAuth, purchaseController.list);
router.get('/:id', requireAuth, purchaseController.detail);
router.post('/', requireAuth, purchaseController.create);

export default router;
