/**
 * Shared constants of the idempotency subsystem.
 *
 * They live in their own module so the store, the key holder and the money
 * operation controller can share them without importing each other.
 */

/** Namespace of the persisted records inside `sessionStorage`. */
export const IDEMPOTENCY_STORAGE_PREFIX = 'cosmetic-shop.idem.v2';

/** Version of the persisted record shape. A record of another version is discarded. */
export const IDEMPOTENCY_RECORD_VERSION = 2;

/** Status of a persisted record: the request may already have been committed. */
export const IDEMPOTENCY_STATUS_UNRESOLVED = 'unresolved';

export default {
  IDEMPOTENCY_STORAGE_PREFIX,
  IDEMPOTENCY_RECORD_VERSION,
  IDEMPOTENCY_STATUS_UNRESOLVED,
};
