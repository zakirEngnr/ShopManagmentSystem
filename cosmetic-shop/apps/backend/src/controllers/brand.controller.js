import { parse, parseId } from '../middleware/validate.js';
import { brandCreateSchema, brandUpdateSchema } from '../schemas/brand.schema.js';
import * as brandService from '../services/brand.service.js';

export async function list(req, res, next) {
  try {
    const rows = await brandService.listBrands();
    res.json({ ok: true, brands: rows });
  } catch (err) {
    next(err);
  }
}

export async function detail(req, res, next) {
  try {
    const id = parseId(req.params);
    const row = await brandService.getBrandById(id);
    res.json({ ok: true, brand: row });
  } catch (err) {
    next(err);
  }
}

export async function create(req, res, next) {
  try {
    const data = parse(brandCreateSchema, req.body);
    const row = await brandService.createBrand(data);
    res.status(201).json({ ok: true, brand: row });
  } catch (err) {
    next(err);
  }
}

export async function update(req, res, next) {
  try {
    const id = parseId(req.params);
    const data = parse(brandUpdateSchema, req.body);
    const row = await brandService.updateBrand(id, data);
    res.json({ ok: true, brand: row });
  } catch (err) {
    next(err);
  }
}

export async function remove(req, res, next) {
  try {
    const id = parseId(req.params);
    await brandService.deleteBrand(id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export default { list, detail, create, update, remove };

