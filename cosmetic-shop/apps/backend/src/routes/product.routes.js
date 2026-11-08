import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { parseId } from '../middleware/validate.js';
import { runUpload } from '../middleware/upload.js';
import * as productController from '../controllers/product.controller.js';

const router = Router();

// Reject invalid :id params (400) before any upload parsing runs.
function parseIdParam(req, res, next) {
  try {
    parseId(req.params);
    next();
  } catch (err) {
    next(err);
  }
}

// All product routes require authentication (spec: protected product routes).
router.get('/', requireAuth, productController.list);
router.get('/:id', requireAuth, productController.detail);
router.post('/', requireAuth, productController.create);
router.put('/:id', requireAuth, productController.update);
router.patch('/:id', requireAuth, productController.update);
router.delete('/:id', requireAuth, productController.remove);
router.post('/:id/image', requireAuth, parseIdParam, runUpload, productController.uploadImage);

export default router;

