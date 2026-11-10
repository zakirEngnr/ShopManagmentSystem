import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as supplierController from '../controllers/supplier.controller.js';

const router = Router();

router.get('/', requireAuth, supplierController.list);
router.post('/', requireAuth, supplierController.create);
router.post('/:id/payment', requireAuth, supplierController.recordPayment);

export default router;
