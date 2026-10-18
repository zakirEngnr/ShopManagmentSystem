import { parse, parseId } from '../middleware/validate.js';
import { productCreateSchema, productUpdateSchema, productQuerySchema } from '../schemas/product.schema.js';
import * as productService from '../services/product.service.js';

export async function list(req, res, next) {
  try {
    const query = parse(productQuerySchema, req.query);
    const result = await productService.listProducts(query);
    res.json({ ok: true, products: result.items, total: result.total, page: result.page, limit: result.limit });
  } catch (err) {
    next(err);
  }
}

export async function detail(req, res, next) {
  try {
    const id = parseId(req.params);
    const row = await productService.getProductById(id);
    res.json({ ok: true, product: row });
  } catch (err) {
    next(err);
  }
}

export async function create(req, res, next) {
  try {
    const data = parse(productCreateSchema, req.body);
    const row = await productService.createProduct(data);
    res.status(201).json({ ok: true, product: row });
  } catch (err) {
    next(err);
  }
}

export async function update(req, res, next) {
  try {
    const id = parseId(req.params);
    const data = parse(productUpdateSchema, req.body);
    const row = await productService.updateProduct(id, data);
    res.json({ ok: true, product: row });
  } catch (err) {
    next(err);
  }
}

export async function remove(req, res, next) {
  try {
    const id = parseId(req.params);
    await productService.deleteProduct(id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export default { list, detail, create, update, remove };

