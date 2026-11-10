import { parse, parseId } from '../middleware/validate.js';
import {
  createCustomerSchema,
  updateCustomerSchema,
  customerListQuerySchema,
} from '../schemas/customer.schema.js';
import * as customerService from '../services/customer.service.js';

export async function list(req, res, next) {
  try {
    const query = parse(customerListQuerySchema, req.query);
    const customers = await customerService.listCustomers(query);
    res.json({ ok: true, customers });
  } catch (err) {
    next(err);
  }
}

export async function get(req, res, next) {
  try {
    const id = parseId(req.params);
    const customer = await customerService.getCustomer(id);
    res.json({ ok: true, customer });
  } catch (err) {
    next(err);
  }
}

export async function create(req, res, next) {
  try {
    const data = parse(createCustomerSchema, req.body);
    const customer = await customerService.createCustomer(data);
    res.status(201).json({ ok: true, customer });
  } catch (err) {
    next(err);
  }
}

export async function update(req, res, next) {
  try {
    const id = parseId(req.params);
    const data = parse(updateCustomerSchema, req.body);
    const customer = await customerService.updateCustomer(id, data);
    res.json({ ok: true, customer });
  } catch (err) {
    next(err);
  }
}

export async function remove(req, res, next) {
  try {
    const id = parseId(req.params);
    await customerService.deleteCustomer(id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export default { list, get, create, update, remove };
