import { parse, parseId } from '../middleware/validate.js';
import { categoryCreateSchema, categoryUpdateSchema } from '../schemas/category.schema.js';
import * as categoryService from '../services/category.service.js';

export async function list(req, res, next) {
  try {
    const rows = await categoryService.listCategories();
    res.json({ ok: true, categories: rows });
  } catch (err) {
    next(err);
  }
}

export async function detail(req, res, next) {
  try {
    const id = parseId(req.params);
    const row = await categoryService.getCategoryById(id);
    res.json({ ok: true, category: row });
  } catch (err) {
    next(err);
  }
}

export async function create(req, res, next) {
  try {
    const data = parse(categoryCreateSchema, req.body);
    const row = await categoryService.createCategory(data);
    res.status(201).json({ ok: true, category: row });
  } catch (err) {
    next(err);
  }
}

export async function update(req, res, next) {
  try {
    const id = parseId(req.params);
    const data = parse(categoryUpdateSchema, req.body);
    const row = await categoryService.updateCategory(id, data);
    res.json({ ok: true, category: row });
  } catch (err) {
    next(err);
  }
}

export async function remove(req, res, next) {
  try {
    const id = parseId(req.params);
    await categoryService.deleteCategory(id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export default { list, detail, create, update, remove };

