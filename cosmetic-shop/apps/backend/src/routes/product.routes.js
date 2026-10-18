import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as productController from '../controllers/product.controller.js';

const router = Router();

// All product routes require authentication (spec: protected product routes).
router.get('/', requireAuth, productController.list);
router.get('/:id', requireAuth, productController.detail);
router.post('/', requireAuth, productController.create);
router.put('/:id', requireAuth, productController.update);
router.patch('/:id', requireAuth, productController.update);
router.delete('/:id', requireAuth, productController.remove);

export default router;

