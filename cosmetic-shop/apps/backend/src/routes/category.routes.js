import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as categoryController from '../controllers/category.controller.js';

const router = Router();

// Public reads.
router.get('/', categoryController.list);
router.get('/:id', categoryController.detail);

// Protected mutations.
router.post('/', requireAuth, categoryController.create);
router.put('/:id', requireAuth, categoryController.update);
router.patch('/:id', requireAuth, categoryController.update);
router.delete('/:id', requireAuth, categoryController.remove);

export default router;

