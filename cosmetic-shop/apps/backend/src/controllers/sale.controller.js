import { parse } from '../middleware/validate.js';
import { createSaleSchema } from '../schemas/sale.schema.js';
import { createSale } from '../services/sale.service.js';

export async function create(req, res, next) {
  try {
    const data = parse(createSaleSchema, req.body);
    const sale = await createSale(req.user.userId, data);
    res.status(201).json({ ok: true, sale, saleItems: sale.items || [] });
  } catch (err) {
    next(err);
  }
}

export default { create };