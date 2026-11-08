import { prisma } from '../db/prisma.js';
import { mapPrismaError, httpError } from '../utils/prismaErrors.js';
import { saveImage, deleteImageFileSilent, imageUrlToFilename } from './upload.service.js';

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
  // A 404 or 409 leaves the image file alone.
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) throw httpError(404, 'Product not found');
  const refs = await Promise.all([
    prisma.saleItem.count({ where: { productId: id } }),
    prisma.stockAdjust.count({ where: { productId: id } }),
  ]);
  if (refs[0] > 0 || refs[1] > 0) throw httpError(409, 'Product is referenced by other records');
  const imageUrl = existing.imageUrl;
  try {
    await prisma.product.delete({ where: { id } });
  } catch (err) {
    mapPrismaError(err, { entity: 'Product' });
  }
  // The DB delete succeeded: remove the image file only now.
  if (imageUrl) {
    const name = imageUrlToFilename(imageUrl);
    if (name) await deleteImageFileSilent(name);
  }
  return { deleted: true };
}

// Serialize image replacement per product inside this process. Interactive
// $transaction support is not relied upon: each product id gets a promise
// chain so concurrent replacements for the same product never interleave.
const replaceLocks = new Map();

async function withReplaceLock(id, task) {
  let previous = replaceLocks.get(id);
  if (!previous) previous = Promise.resolve();
  const next = previous.then(task).catch((err) => {
    throw err;
  });
  replaceLocks.set(id, next);
  try {
    return await next;
  } finally {
    if (replaceLocks.get(id) === next) replaceLocks.delete(id);
  }
}

/**
 * Replace the product image. Writes the new file first, then atomically
 * swaps imageUrl with updateMany CAS (compare-and-swap) retries; the old
 * file is removed only after a successful swap. Any failure after the new
 * file is written removes the new file and rethrows; the OLD image is
 * untouched. Interactive $transaction is not used.
 */
export async function replaceProductImage(id, { buffer, ext }) {
  return withReplaceLock(id, async () => {
    // (1) the product must exist BEFORE any disk write.
    const existing = await prisma.product.findUnique({ where: { id } });
    if (!existing) throw httpError(404, 'Product not found');

    // (2) save the new image to disk under a server-generated name.
    const filename = saveImage(buffer, ext);
    const newImageUrl = '/uploads/' + filename;

    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Re-read the current imageUrl every attempt (CAS expected value).
      const row = await prisma.product.findUnique({ where: { id } });
      if (!row) {
        await deleteImageFileSilent(filename);
        throw httpError(404, 'Product not found');
      }
      try {
        const result = await prisma.product.updateMany({
          where: { id, imageUrl: row.imageUrl ?? null },
          data: { imageUrl: newImageUrl },
        });
        if (result.count === 1) {
          // (6) only after a successful swap, remove the old image file.
          const oldName = row.imageUrl ? imageUrlToFilename(row.imageUrl) : null;
          if (oldName) await deleteImageFileSilent(oldName);
          return await prisma.product.findUnique({ where: { id } });
        }
        // count 0: concurrent modification, retry with fresh current value.
      } catch (err) {
        lastErr = err;
      }
    }
    // (5) any failure after step 3: remove the new file, rethrow. OLD image
    // untouched. Three CAS misses -> 409.
    await deleteImageFileSilent(filename);
    if (lastErr) throw lastErr;
    throw httpError(409, 'Concurrent modification');
  });
}

export default { listProducts, getProductById, createProduct, updateProduct, deleteProduct, replaceProductImage };


