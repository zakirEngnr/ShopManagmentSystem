import { parse, parseId } from '../middleware/validate.js';
import { createExpenseSchema, updateExpenseSchema } from '../schemas/expense.schema.js';
import * as expenseService from '../services/expense.service.js';

export async function create(req, res, next) {
  try {
    const data = parse(createExpenseSchema, req.body);
    const expense = await expenseService.createExpense(data);
    res.status(201).json({ ok: true, expense });
  } catch (err) {
    next(err);
  }
}

export async function list(req, res, next) {
  try {
    const result = await expenseService.listExpenses(req.query);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

export async function get(req, res, next) {
  try {
    const id = parseId(req.params);
    const expense = await expenseService.getExpense(id);
    res.json({ ok: true, expense });
  } catch (err) {
    next(err);
  }
}

export async function update(req, res, next) {
  try {
    const id = parseId(req.params);
    const data = parse(updateExpenseSchema, req.body);
    const expense = await expenseService.updateExpense(id, data);
    res.json({ ok: true, expense });
  } catch (err) {
    next(err);
  }
}

export async function remove(req, res, next) {
  try {
    const id = parseId(req.params);
    await expenseService.deleteExpense(id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export default { create, list, get, update, remove };
