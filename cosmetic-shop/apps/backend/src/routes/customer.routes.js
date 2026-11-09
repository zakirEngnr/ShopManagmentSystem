import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as customerController from '../controllers/customer.controller.js';
import * as khataController from '../controllers/khata.controller.js';

const router = Router();

// /outstanding must be registered before /:id so it is not treated as an id.
router.get('/', requireAuth, customerController.list);
router.get('/outstanding', requireAuth, khataController.outstanding);
router.get('/:id', requireAuth, customerController.get);
router.post('/', requireAuth, customerController.create);
router.patch('/:id', requireAuth, customerController.update);
router.delete('/:id', requireAuth, customerController.remove);
router.get('/:id/ledger', requireAuth, khataController.ledger);
router.post('/:id/payment', requireAuth, khataController.payment);

export default router;
