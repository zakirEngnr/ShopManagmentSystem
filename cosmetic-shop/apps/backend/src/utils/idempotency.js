const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isValidUuid(value) {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

export function extractIdempotencyKey(headers) {
  const key = headers['idempotency-key'];
  if (key === undefined || key === null || key === '') return undefined;
  if (!isValidUuid(key)) {
    const err = new Error('Invalid Idempotency-Key: must be a valid UUID');
    err.status = 400;
    err.expose = true;
    return err;
  }
  return key;
}

export default { isValidUuid, extractIdempotencyKey };
