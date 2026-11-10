import { parse, parseId } from '../middleware/validate.js';
import { recordPaymentSchema, recordDebtSchema, ledgerQuerySchema } from '../schemas/customer.schema.js';
import * as khataService from '../services/khata.service.js';

export async function ledger(req, res, next) {
  try {
    const customerId = parseId(req.params);
    const { page, limit } = parse(ledgerQuerySchema, req.query);
    const result = await khataService.getLedger(customerId, { page, limit });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

export async function payment(req, res, next) {
  try {
    const customerId = parseId(req.params);
    const { amount, description } = parse(recordPaymentSchema, req.body);
    const result = await khataService.recordPayment(customerId, amount, description);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

export async function debt(req, res, next) {
  try {
    const customerId = parseId(req.params);
    const { amount, description } = parse(recordDebtSchema, req.body);
    const result = await khataService.recordDebt(customerId, amount, description);
    res.status(201).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

export async function outstanding(req, res, next) {
  try {
    const result = await khataService.getOutstanding();
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

export default { ledger, payment, debt, outstanding };
