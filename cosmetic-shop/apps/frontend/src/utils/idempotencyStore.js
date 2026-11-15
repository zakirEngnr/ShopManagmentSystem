/**
 * Durable storage for unresolved money-writing operations.
 *
 * A request can commit on the server while its response never reaches the
 * browser. When that happens the frontend has to remember the request, so the
 * exact same request can be replayed later - possibly after a page reload or
 * after the user navigated away and came back.
 *
 * The state is kept in `sessionStorage`:
 *
 *   - it lives for the browser tab only, so it cannot leak between users;
 *   - it is not sent to the server, so it cannot leak into a request body;
 *   - it disappears when the tab is closed, which is the correct lifetime for
 *     "this request may already have been saved".
 *
 * A persisted record holds the EXACT original request:
 *
 *   { v, scope, key, signature, payload, entity, status, createdAt }
 *
 *   key       - the idempotency key that was put on the wire
 *   payload   - the request body that was put on the wire (byte for byte)
 *   signature - the canonical form of that payload, used to recognise it
 *   entity    - the customer/supplier the request targets, so a retry can
 *               rebuild the URL without the form that is currently open
 *   scope     - the operation the record belongs to
 *
 * Storing the key alone is NOT enough: the backend replays the ORIGINAL
 * transaction for a repeated key, so a retry must carry the original body as
 * well. Storing the payload alone is not enough either: the key is what makes
 * the backend recognise the retry.
 *
 * Only the request itself is stored. No credentials, no tokens and no other
 * sensitive data are ever written here - the Bearer token lives in
 * `localStorage` under a different key and is never part of a payload.
 */
import { IDEMPOTENCY_RECORD_VERSION, IDEMPOTENCY_STORAGE_PREFIX } from './idempotencyConstants.js';

const PROBE_KEY = `${IDEMPOTENCY_STORAGE_PREFIX}__probe__`;

/** A v4-ish UUID. The backend rejects anything that is not a UUID. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `sessionStorage` can be missing or throw (private browsing modes, blocked
 * storage). Returns null in that case so the caller can fall back to memory.
 */
function getSessionStorage() {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) return null;
    storage.setItem(PROBE_KEY, '1');
    storage.removeItem(PROBE_KEY);
    return storage;
  } catch {
    return null;
  }
}

/**
 * A stored record is only trusted when every field has the expected shape.
 * Anything else is dropped, so a corrupted or hand-edited entry can never
 * make the frontend replay a request it does not understand.
 *
 * The key must be a UUID, because the backend rejects a malformed
 * `Idempotency-Key` with a 400. The payload must be a plain object, because
 * every money-writing endpoint takes a JSON object body.
 */
export function isValidIdempotencyRecord(record, scope) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (record.v !== IDEMPOTENCY_RECORD_VERSION) return false;
  if (typeof record.scope !== 'string' || record.scope !== scope || record.scope === '') return false;
  if (typeof record.key !== 'string' || !UUID_REGEX.test(record.key)) return false;
  if (typeof record.signature !== 'string' || record.signature === '') return false;
  if (!record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) return false;
  if (record.status !== 'unresolved') return false;
  if (typeof record.createdAt !== 'string' || record.createdAt === '') return false;
  // The entity the request targets (a customer id, a supplier id). It is
  // stored so a retry can rebuild the URL of the request without relying on
  // the state of the form that is currently open.
  if (record.entity !== null && (typeof record.entity !== 'string' || record.entity === '')) {
    return false;
  }
  return true;
}

/**
 * Create a store. Without a usable `sessionStorage` the store keeps the
 * records in memory, which still protects against a duplicate submission
 * inside the same page but not across a reload.
 */
export function createIdempotencyStore({ storage = getSessionStorage() } = {}) {
  const memory = new Map();
  const listeners = new Set();
  let version = 0;

  const notify = () => {
    version += 1;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* a broken listener must not break the store */
      }
    }
  };

  const keyFor = (scope) => `${IDEMPOTENCY_STORAGE_PREFIX}:${scope}`;

  /**
   * The memory map is checked first: it holds the record that was written
   * last, also when writing to `sessionStorage` failed (quota, blocked
   * storage). Reading the storage first would then return a stale record.
   */
  function readRaw(scope) {
    if (memory.has(scope)) return memory.get(scope);
    if (storage) {
      try {
        return storage.getItem(keyFor(scope));
      } catch {
        return null;
      }
    }
    return null;
  }

  function writeRaw(scope, serialized) {
    memory.set(scope, serialized);
    if (storage) {
      try {
        storage.setItem(keyFor(scope), serialized);
        return true;
      } catch {
        // Storage is full or unavailable: the memory copy above is used.
      }
    }
    return false;
  }

  function removeRaw(scope, { silent = false } = {}) {
    memory.delete(scope);
    if (storage) {
      try {
        storage.removeItem(keyFor(scope));
      } catch {
        /* ignore */
      }
    }
    if (!silent) notify();
  }

  /**
   * Every scope that currently holds an unresolved record.
   *
   * The page level banners use this to warn about an unresolved operation
   * whose dialog is not open - for example a manual debt entry for a
   * customer that the user navigated away from.
   */
  function listScopes() {
    const scopes = new Set(memory.keys());

    if (storage) {
      try {
        if (typeof storage.length === 'number' && typeof storage.key === 'function') {
          for (let index = 0; index < storage.length; index += 1) {
            const storageKey = storage.key(index);
            if (typeof storageKey !== 'string') continue;
            if (!storageKey.startsWith(`${IDEMPOTENCY_STORAGE_PREFIX}:`)) continue;
            scopes.add(storageKey.slice(IDEMPOTENCY_STORAGE_PREFIX.length + 1));
          }
        }
      } catch {
        /* ignore */
      }
    }

    return [...scopes].filter((scope) => scope !== '');
  }

  return {
    /** True when the records survive a reload. */
    durable: Boolean(storage),

    /**
     * Read the unresolved record of a scope. Invalid records are removed and
     * reported as absent.
     */
    read(scope) {
      if (typeof scope !== 'string' || scope === '') return null;

      const raw = readRaw(scope);
      if (raw === null || raw === undefined) return null;

      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }

      if (!isValidIdempotencyRecord(parsed, scope)) {
        // The cleanup is silent: it must not change the version while a
        // component is rendering.
        removeRaw(scope, { silent: true });
        return null;
      }

      return parsed;
    },

    /** Persist the unresolved record of a scope. */
    write(scope, record) {
      if (typeof scope !== 'string' || scope === '') return false;
      if (!isValidIdempotencyRecord(record, scope)) return false;

      let serialized = null;
      try {
        serialized = JSON.stringify(record);
      } catch {
        return false;
      }

      const written = writeRaw(scope, serialized);
      notify();
      return written;
    },

    /** Forget the record of a scope. */
    remove(scope) {
      if (typeof scope !== 'string' || scope === '') return;
      removeRaw(scope);
    },

    /** Every scope that currently holds an unresolved record. */
    listScopes,

    /** A counter that changes whenever a record is written or removed. */
    getVersion: () => version,

    /** Listen for changes. Returns the unsubscribe function. */
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export default { createIdempotencyStore, isValidIdempotencyRecord };
