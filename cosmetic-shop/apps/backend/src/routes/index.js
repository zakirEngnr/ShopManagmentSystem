import { Router } from 'express';
import authRoutes from './auth.routes.js';

const router = Router();

router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'cosmetic-shop-backend', time: new Date().toISOString() });
});

router.use('/auth', authRoutes);

export default router;
