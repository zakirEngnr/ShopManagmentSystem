import { prisma } from '../db/prisma.js';
import { httpError, mapPrismaError } from '../utils/prismaErrors.js';

/**
 * Customer (Khata ledger owner) service.
 *
 * All balance mutations go through the khata service; this service only
 * manages the customer profile. The `balance` and ledger transaction fields
 * are never writable through this service.
 */

const PERMITTED_FIELDS = ['name', 'phone', 'email', 'address', 'notes', 'type'];

function cleanPhone(value) {
  // Treat omitted / empty / null phone as null so multiple customers may
  // share an absent phone (SQLite only enforces uniqueness among non-nulls).
  if (value === undefined || value === null || value === '') return null;
  return String(value).trim();
}

export async function listCustomers(query = {}) {
  const where = {};
  if (query.type) {
    where.type = query.type;
  }
  return prisma.customer.findMany({ where, orderBy: { name: 'asc' } });
}

export async function getCustomer(id) {
  const row = await prisma.customer.findUnique({ where: { id } });
  if (!row) throw httpError(404, 'Customer not found');
  return row;
}

export async function createCustomer(data) {
  const phone = cleanPhone(data.phone);
  try {
    return await prisma.customer.create({
      data: {
        name: data.name,
        phone,
        email: data.email,
        address: data.address,
        notes: data.notes,
        type: data.type ?? 'RETAIL',
        balance: 0,
      },
    });
  } catch (err) {
    // P2002 on the unique phone index -> 409 'phone already exists'
    mapPrismaError(err, { entity: 'Customer' });
    throw err;
  }
}

export async function updateCustomer(id, data) {
  const phone = cleanPhone(data.phone);
  const updateData = {};
  for (const field of PERMITTED_FIELDS) {
    if (field === 'phone') {
      if (data.phone !== undefined) updateData.phone = phone;
    } else if (data[field] !== undefined) {
      updateData[field] = data[field];
    }
  }
  try {
    return await prisma.customer.update({
      where: { id },
      data: updateData,
    });
  } catch (err) {
    // P2025 -> 404 not found; P2002 on phone -> 409 'phone already exists'
    mapPrismaError(err, { entity: 'Customer' });
    throw err;
  }
}

export async function deleteCustomer(id) {
  try {
    return await prisma.$transaction(async (tx) => {
      // Touch the customer row first to acquire the write lock early. This
      // serializes against concurrent ledger writes so a concurrent
      // KhataTransaction insert cannot slip in between the count and the
      // delete, which would otherwise be silently cascaded away.
      await tx.$executeRawUnsafe(
        'UPDATE "Customer" SET "updatedAt" = "updatedAt" WHERE "id" = ?',
        id,
      );
      const txCount = await tx.khataTransaction.count({ where: { customerId: id } });
      if (txCount > 0) {
        throw httpError(409, 'Customer has ledger transactions and cannot be deleted');
      }
      return await tx.customer.delete({ where: { id } });
    });
  } catch (err) {
    if (err?.expose) throw err;
    // P2025 -> 404 not found (customer deleted by a concurrent request)
    mapPrismaError(err, { entity: 'Customer' });
    throw err;
  }
}

export default { listCustomers, getCustomer, createCustomer, updateCustomer, deleteCustomer };
