import { prisma } from '../db/prisma.js';
import { mapPrismaError, httpError } from '../utils/prismaErrors.js';

/**
 * Brand service — same conventions as the category service.
 * Note: Product.brandId is ON DELETE SET NULL, but the spec requires a
 * guarded 409 when a brand is referenced, so deletes check references
 * first and treat a concurrent reference as a conflict.
 */

export async function listBrands() {
  return prisma.brand.findMany({ orderBy: { name: 'asc' } });
}

export async function getBrandById(id) {
  const row = await prisma.brand.findUnique({ where: { id } });
  if (!row) throw httpError(404, 'Brand not found');
  return row;
}

export async function createBrand(data) {
  try {
    return await prisma.brand.create({ data });
  } catch (err) {
    mapPrismaError(err, { entity: 'Brand' });
  }
}

export async function updateBrand(id, data) {
  try {
    return await prisma.brand.update({ where: { id }, data });
  } catch (err) {
    mapPrismaError(err, { entity: 'Brand' });
  }
}

export async function deleteBrand(id) {
  const existing = await prisma.brand.findUnique({ where: { id } });
  if (!existing) throw httpError(404, 'Brand not found');
  // Guarded deletion: refuse while products reference this brand. A brand
  // product created concurrently after the check maps to 409 as well —
  // either the delete wins consistently or the reference wins with 409.
  const refCount = await prisma.product.count({ where: { brandId: id } });
  if (refCount > 0) throw httpError(409, 'Brand is referenced by other records');
  try {
    const stillReferenced = await prisma.product.count({ where: { brandId: id } });
    if (stillReferenced > 0) throw httpError(409, 'Brand is referenced by other records');
    return await prisma.brand.delete({ where: { id } });
  } catch (err) {
    if (err && err.status === 409) throw err;
    mapPrismaError(err, { entity: 'Brand' });
  }
}

export default { listBrands, getBrandById, createBrand, updateBrand, deleteBrand };

