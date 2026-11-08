import { parse, parseId } from '../middleware/validate.js';
import { createStockAdjustSchema } from '../schemas/stock.schema.js';
import * as stockService from '../services/stock.service.js';

export async function create(req, res, next) {
  try {
    const data = parse(createStockAdjustSchema, req.body);
    const result = await stockService.adjustStock(req.user.userId, data);
    res.status(201).json({ ok: true, ...result });
  } catch (err) { next(err); }
}

export async function list(req, res, next) {
  try {
    const result = await stockService.listAdjustments(req.query);
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
}

export async function getForProduct(req, res, next) {
  try {
    const id = parseId(req.params);
    const result = await stockService.getAdjustmentsForProduct(id);
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
}
