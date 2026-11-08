import { parse } from '../middleware/validate.js';
import { createSaleSchema } from '../schemas/sale.schema.js';
import { createSale } from '../services/sale.service.js';

export function create(req, res, next) {
  try {
    const data = parse(createSaleSchema, req.body);
    const sale = saleService.createSale(req.user.userId, data);
    res.status(201).json({ ok: true, sale });
  } catch (err) {
    next(err);
  }
}