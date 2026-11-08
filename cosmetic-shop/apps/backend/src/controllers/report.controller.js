import { parse } from '../middleware/validate.js';
import {
  dailyDateSchema,
  dateRangeSchema,
  topProductsSchema,
  daysQuerySchema,
} from '../schemas/report.schema.js';
import * as reportService from '../services/report.service.js';

export async function daily(req, res, next) {
  try {
    const { date } = parse(dailyDateSchema, req.query);
    const report = await reportService.getDailyReport(date);
    res.status(200).json({ ok: true, report });
  } catch (err) {
    next(err);
  }
}

export async function pnl(req, res, next) {
  try {
    // GET /pnl receives query parameters, not a request body.
    const { from, to } = parse(dateRangeSchema, req.query);
    const report = await reportService.getPnlReport(from, to);
    res.status(200).json({ ok: true, report });
  } catch (err) {
    next(err);
  }
}

export async function topProducts(req, res, next) {
  try {
    const { from, to, limit } = parse(topProductsSchema, req.query);
    const products = await reportService.getTopProducts(from, to, limit);
    res.status(200).json({ ok: true, products });
  } catch (err) {
    next(err);
  }
}

export async function lowStock(req, res, next) {
  try {
    const products = await reportService.getLowStockProducts();
    res.status(200).json({ ok: true, products });
  } catch (err) {
    next(err);
  }
}

export async function expiringSoon(req, res, next) {
  try {
    const { days } = parse(daysQuerySchema, req.query);
    const products = await reportService.getExpiringSoonProducts(days);
    res.status(200).json({ ok: true, products });
  } catch (err) {
    next(err);
  }
}

export default { daily, pnl, topProducts, lowStock, expiringSoon };

