import { parse, parseId } from '../middleware/validate.js';
import { createSupplierSchema, recordSupplierPaymentSchema, supplierListQuerySchema } from '../schemas/supplier.schema.js';
import * as supplierService from '../services/supplier.service.js';
import { extractIdempotencyKey } from '../utils/idempotency.js';

export async function list(req, res, next) {
  try {
    const query = parse(supplierListQuerySchema, req.query);
    const result = await supplierService.listSuppliers(query);
    res.json({ ok: true, suppliers: result.suppliers, total: result.total, page: result.page, limit: result.limit, outstandingTotal: result.outstandingTotal });
  } catch (err) {
    next(err);
  }
}

export async function create(req, res, next) {
  try {
    const data = parse(createSupplierSchema, req.body);
    const supplier = await supplierService.createSupplier(data);
    res.status(201).json({ ok: true, supplier });
  } catch (err) {
    next(err);
  }
}

export async function recordPayment(req, res, next) {
  try {
    const supplierId = parseId(req.params);
    const data = parse(recordSupplierPaymentSchema, req.body);
    const idempotencyKey = extractIdempotencyKey(req.headers);
    if (idempotencyKey instanceof Error) throw idempotencyKey;
    const result = await supplierService.recordPayment(supplierId, data, idempotencyKey);
    res.status(201).json({ ok: true, payment: result.payment, supplier: result.supplier, allocations: result.allocations });
  } catch (err) {
    next(err);
  }
}

export default { list, create, recordPayment };
