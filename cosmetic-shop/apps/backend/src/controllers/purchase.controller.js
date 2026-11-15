import { parse } from '../middleware/validate.js';
import { createPurchaseSchema, purchaseListQuerySchema } from '../schemas/purchase.schema.js';
import * as purchaseService from '../services/purchase.service.js';
import { parseId } from '../middleware/validate.js';
import { extractIdempotencyKey } from '../utils/idempotency.js';

export async function list(req, res, next) {
  try {
    const query = parse(purchaseListQuerySchema, req.query);
    const result = await purchaseService.listPurchases(query);
    res.json({ ok: true, purchases: result.purchases, total: result.total, page: result.page, limit: result.limit });
  } catch (err) {
    next(err);
  }
}

export async function create(req, res, next) {
  try {
    const data = parse(createPurchaseSchema, req.body);
    const idempotencyKey = extractIdempotencyKey(req.headers);
    if (idempotencyKey instanceof Error) throw idempotencyKey;
    const purchase = await purchaseService.createPurchase(data, idempotencyKey);
    res.status(201).json({ ok: true, purchase });
  } catch (err) {
    next(err);
  }
}

export async function detail(req, res, next) {
  try {
    const id = parseId(req.params);
    const purchase = await purchaseService.getPurchaseById(id);
    res.json({ ok: true, purchase });
  } catch (err) {
    next(err);
  }
}

export default { list, create, detail };
