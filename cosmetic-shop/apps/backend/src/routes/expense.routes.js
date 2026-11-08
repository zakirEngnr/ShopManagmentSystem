import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as expenseController from '../controllers/expense.controller.js';

const router = Router();

router.post('/', requireAuth, expenseController.create);
router.get('/', requireAuth, expenseController.list);
router.get('/:id', requireAuth, expenseController.get);
router.patch('/:id', requireAuth, expenseController.update);
router.delete('/:id', requireAuth, expenseController.remove);

export default router;
