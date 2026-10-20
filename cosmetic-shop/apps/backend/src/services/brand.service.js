import { prisma } from '../db/prisma.js';
import { mapPrismaError, httpError } from '../utils/prismaErrors.js';

/**
 * Brand service — same conventions as the category service.
 * Product.brandId is ON DELETE RESTRICT, so a referenced brand delete fails
 * at the database (P2003 -> 409 'Brand is referenced by other records').
 * A concurrent product create either commits first (delete -> 409) or
 * fails first (delete -> 200): the FK is the single source of truth.
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
  try {
    return await prisma.brand.delete({ where: { id } });
  } catch (err) {
    mapPrismaError(err, { entity: 'Brand' });
  }
}

export default { listBrands, getBrandById, createBrand, updateBrand, deleteBrand };

