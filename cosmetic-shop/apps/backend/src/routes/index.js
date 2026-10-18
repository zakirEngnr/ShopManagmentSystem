import { Router } from 'express';
import authRoutes from './auth.routes.js';
import categoryRoutes from './category.routes.js';
import brandRoutes from './brand.routes.js';

const router = Router();

router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'cosmetic-shop-backend', time: new Date().toISOString() });
});

router.use('/auth', authRoutes);
router.use('/categories', categoryRoutes);
router.use('/brands', brandRoutes);

export default router;
