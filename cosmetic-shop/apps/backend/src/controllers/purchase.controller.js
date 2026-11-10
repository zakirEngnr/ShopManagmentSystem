import { parse } from '../middleware/validate.js';
import { createPurchaseSchema, purchaseListQuerySchema } from '../schemas/purchase.schema.js';
import * as purchaseService from '../services/purchase.service.js';
import { parseId } from '../middleware/validate.js';

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
    const purchase = await purchaseService.createPurchase(data);
    res.status(201).json({ ok: true, purchase });
  } catch (err) {
    next(err);
  }
}

export async function detail(req, res, next) {
  try {
    const id = parseId(req.params);
    const result = await purchaseService.listPurchases({ page: 1, limit: 1, supplierId: id });
    const purchase = result.purchases[0];
    if (!purchase) throw new Error('Purchase not found');
    res.json({ ok: true, purchase });
  } catch (err) {
    next(err);
  }
}

export default { list, create, detail };
