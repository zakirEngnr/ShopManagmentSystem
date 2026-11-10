import { parse, parseId } from '../middleware/validate.js';
import { createSupplierSchema, recordSupplierPaymentSchema, supplierListQuerySchema } from '../schemas/supplier.schema.js';
import * as supplierService from '../services/supplier.service.js';

export async function list(req, res, next) {
  try {
    const query = parse(supplierListQuerySchema, req.query);
    const result = await supplierService.listSuppliers(query);
    res.json({ ok: true, suppliers: result.suppliers, total: result.total, page: result.page, limit: result.limit });
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
    const result = await supplierService.recordPayment(supplierId, data);
    res.status(201).json({ ok: true, payment: result.payment, supplier: result.supplier, allocations: result.allocations });
  } catch (err) {
    next(err);
  }
}

export default { list, create, recordPayment };
