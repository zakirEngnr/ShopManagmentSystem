import { parse } from '../middleware/validate.js';
import { createSaleSchema } from '../schemas/sale.schema.js';
import { createSale } from '../services/sale.service.js';
import { extractIdempotencyKey } from '../utils/idempotency.js';

export async function create(req, res, next) {
  try {
    const data = parse(createSaleSchema, req.body);
    const idempotencyKey = extractIdempotencyKey(req.headers);
    if (idempotencyKey instanceof Error) throw idempotencyKey;
    const sale = await createSale(req.user.userId, data, idempotencyKey);
    res.status(201).json({ ok: true, sale, saleItems: sale.items || [] });
  } catch (err) {
    next(err);
  }
}

export default { create };