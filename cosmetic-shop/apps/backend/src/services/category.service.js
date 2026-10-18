import { prisma } from '../db/prisma.js';
import { mapPrismaError, httpError } from '../utils/prismaErrors.js';

/**
 * Category service — thin Prisma wrapper with repo-wide error mapping.
 * - Unique name -> 409 via mapPrismaError(P2002)
 * - Missing id -> 404 via mapPrismaError(P2025) or explicit check
 * - Delete is guarded: refuses when products reference the category and
 *   maps concurrent FK failures (P2003) to 409 so a race can never leave
 *   an invalid relational state.
 */

export async function listCategories() {
  return prisma.category.findMany({ orderBy: { name: 'asc' } });
}

export async function getCategoryById(id) {
  const row = await prisma.category.findUnique({ where: { id } });
  if (!row) throw httpError(404, 'Category not found');
  return row;
}

export async function createCategory(data) {
  try {
    return await prisma.category.create({ data });
  } catch (err) {
    mapPrismaError(err, { entity: 'Category' });
  }
}

export async function updateCategory(id, data) {
  try {
    return await prisma.category.update({ where: { id }, data });
  } catch (err) {
    mapPrismaError(err, { entity: 'Category' });
  }
}

export async function deleteCategory(id) {
  const existing = await prisma.category.findUnique({ where: { id } });
  if (!existing) throw httpError(404, 'Category not found');
  // Guarded deletion: pre-check keeps the common case a clean 409 with a
  // stable message. A product created concurrently after this check still
  // fails safely via the RESTRICT FK (P2003 -> 409) below — never silently
  // removed.
  const refCount = await prisma.product.count({ where: { categoryId: id } });
  if (refCount > 0) throw httpError(409, 'Category is referenced by other records');
  try {
    return await prisma.category.delete({ where: { id } });
  } catch (err) {
    mapPrismaError(err, { entity: 'Category' });
  }
}

export default { listCategories, getCategoryById, createCategory, updateCategory, deleteCategory };

