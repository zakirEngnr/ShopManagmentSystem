import { Router } from 'express';
import requireAuth from '../middleware/auth.js';
import saleController from '../controllers/sale.controller.js';

const router = Router();

router.post('/', requireAuth, saleController.create);

export default router;