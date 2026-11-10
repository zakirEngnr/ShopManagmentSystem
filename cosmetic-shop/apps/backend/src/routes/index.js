import { Router } from 'express';
import authRoutes from './auth.routes.js';
import categoryRoutes from './category.routes.js';
import brandRoutes from './brand.routes.js';
import productRoutes from './product.routes.js';
import saleRoutes from './sale.routes.js';
import stockRoutes from './stock.routes.js';
import expenseRoutes from './expense.routes.js';
import reportRoutes from './report.routes.js';
import customerRoutes from './customer.routes.js';
import supplierRoutes from './supplier.routes.js';
import purchaseRoutes from './purchase.routes.js';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'cosmetic-shop-backend', time: new Date().toISOString() });
});

router.use('/auth', authRoutes);
router.use('/categories', categoryRoutes);
router.use('/brands', brandRoutes);
router.use('/products', productRoutes);
router.use('/sales', saleRoutes);
router.use('/stock', stockRoutes);
router.use('/expenses', expenseRoutes);
router.use('/reports', reportRoutes);
router.use('/customers', customerRoutes);
router.use('/suppliers', supplierRoutes);
router.use('/purchases', purchaseRoutes);

export default router;
