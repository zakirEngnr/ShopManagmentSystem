import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as brandController from '../controllers/brand.controller.js';

const router = Router();

// Public reads.
router.get('/', brandController.list);
router.get('/:id', brandController.detail);

// Protected mutations.
router.post('/', requireAuth, brandController.create);
router.put('/:id', requireAuth, brandController.update);
router.patch('/:id', requireAuth, brandController.update);
router.delete('/:id', requireAuth, brandController.remove);

export default router;

