import { prisma } from '../db/prisma.js';
import { mapPrismaError, httpError } from '../utils/prismaErrors.js';

/**
 * Product service — Prisma wrapper following category/brand conventions.
 * - Unique sku/barcode -> 409, missing record -> 404, FK conflict -> 409.
 * - Never echoes submitted values; fixed entity messages only.
 * - Stock is create-only here: creation accepts an optional initial stock;
 *   no update path modifies stock (stock module owns adjustments).
 * - Delete is guarded + atomic: referenced products (sale items or stock
 *   history) cannot be removed; concurrent references surface as 409.
 */

function toExpiry(value) {
  if (value === undefined || value === null) return value;
  return new Date(value);
}

function toCreateData(data) {
  const out = { ...data };
  if (out.brandId === undefined) delete out.brandId;
  if (out.expiryDate !== undefined) out.expiryDate = toExpiry(out.expiryDate);
  return out;
}

function toUpdateData(data) {
  const out = { ...data };
  if (out.expiryDate !== undefined) out.expiryDate = toExpiry(out.expiryDate);
  return out;
}

async function assertCategoryExists(categoryId) {
  const row = await prisma.category.findUnique({ where: { id: categoryId } });
  if (!row) throw httpError(404, 'Category not found');
}

async function assertBrandExists(brandId) {
  if (brandId === null || brandId === undefined) return;
  const row = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!row) throw httpError(404, 'Brand not found');
}
export async function listProducts(query) {
  const { page, limit, sortBy, sortOrder, search, categoryId, brandId, type } = query;
  const where = {};
  if (search) {
    where.OR = [{ name: { contains: search } }, { sku: { contains: search } }];
    if (search.length <= 40) where.OR.push({ barcode: { contains: search } });
  }
  if (categoryId !== undefined) where.categoryId = categoryId;
  if (brandId !== undefined) where.brandId = brandId;
  if (type !== undefined) where.type = type;
  // Deterministic ordering: requested field + id as stable secondary sort.
  const orderBy = [{ [sortBy]: sortOrder }, { id: sortOrder }];
  const skip = (page - 1) * limit;
  const [total, items] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({ where, orderBy, take: limit, skip }),
  ]);
  return { items, total, page, limit };
}

export async function getProductById(id) {
  const row = await prisma.product.findUnique({ where: { id } });
  if (!row) throw httpError(404, 'Product not found');
  return row;
}

export async function createProduct(data) {
  await assertCategoryExists(data.categoryId);
  await assertBrandExists(data.brandId);
  try {
    return await prisma.product.create({ data: toCreateData(data) });
  } catch (err) {
    // A category/brand deleted between check and write surfaces as P2003.
    if (err && err.code === 'P2003') throw httpError(409, 'Product references missing records');
    mapPrismaError(err, { entity: 'Product' });
  }
}

export async function updateProduct(id, data) {
  if (data.categoryId !== undefined) await assertCategoryExists(data.categoryId);
  if (data.brandId !== undefined) await assertBrandExists(data.brandId);
  try {
    return await prisma.product.update({ where: { id }, data: toUpdateData(data) });
  } catch (err) {
    if (err && err.code === 'P2003') throw httpError(409, 'Product references missing records');
    mapPrismaError(err, { entity: 'Product' });
  }
}

export async function deleteProduct(id) {
  // Guarded delete: pre-checks give clean 404/409, and any reference created
  // concurrently (sale item or stock adjust, both RESTRICT) fails the delete
  // with P2003 -> 409. Nothing is cascaded — sales/stock history stay.
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) throw httpError(404, 'Product not found');
  const refs = await Promise.all([
    prisma.saleItem.count({ where: { productId: id } }),
    prisma.stockAdjust.count({ where: { productId: id } }),
  ]);
  if (refs[0] > 0 || refs[1] > 0) throw httpError(409, 'Product is referenced by other records');
  try {
    await prisma.product.delete({ where: { id } });
    return { deleted: true };
  } catch (err) {
    mapPrismaError(err, { entity: 'Product' });
  }
}

export default { listProducts, getProductById, createProduct, updateProduct, deleteProduct };


