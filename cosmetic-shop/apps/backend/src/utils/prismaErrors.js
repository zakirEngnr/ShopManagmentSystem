/**
 * Prisma error mapping + tiny HTTP error helper.
 *
 * Conventions (repo-wide):
 * - throw `Error` with `.status` and `.expose = true` for expected failures
 * - `errorHandler` responds `{ ok: false, error: { message } }`
 */

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

function uniqueFields(err) {
  const meta = err?.meta;
  const fromAdapter =
    meta?.driverAdapterError?.cause?.constraint?.fields ??
    meta?.driverAdapterError?.cause?.constraint?.columns ??
    meta?.driverAdapterError?.constraint?.fields;
  if (Array.isArray(fromAdapter) && fromAdapter.length > 0) {
    return fromAdapter.map((f) => String(f));
  }
  const target = meta?.target;
  if (Array.isArray(target) && target.length > 0) {
    return target.map((f) => String(f));
  }
  if (typeof target === 'string' && target.length > 0) {
    return [target];
  }
  return [];
}

/**
 * Map known Prisma errors to HTTP errors.
 * - P2002 unique violation -> 409 naming the field when discoverable
 * - P2025 record not found -> 404
 * - P2003 FK violation -> 409 ("referenced by other records") for deletes
 * Anything else is rethrown unchanged (becomes 500 via errorHandler).
 */
export function mapPrismaError(err, { entity = 'Record' } = {}) {
  if (err?.code === 'P2002') {
    const fields = uniqueFields(err);
    const message =
      fields.length > 0 ? `${fields.join(', ')} already exists` : `${entity} already exists`;
    throw httpError(409, message);
  }
  if (err?.code === 'P2025') {
    throw httpError(404, `${entity} not found`);
  }
  if (err?.code === 'P2003') {
    throw httpError(409, `${entity} is referenced by other records`);
  }
  throw err;
}

export default { httpError, mapPrismaError };
