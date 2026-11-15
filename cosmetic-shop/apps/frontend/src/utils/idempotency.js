/**
 * Idempotency-Key support for the money-writing endpoints.
 *
 * The backend treats the `Idempotency-Key` header as an opaque token and
 * stores it in a UNIQUE column on the row it creates
 * (`Sale.idempotencyKey`, `Purchase.idempotencyKey`,
 * `SupplierPayment.idempotencyKey`, `KhataTransaction.idempotencyKey`).
 * A retry that carries the same key returns the record that was created
 * first, so the stock decrement, the invoice number, the customer debt and the
 * ledger entry happen exactly once.
 *
 * THE AMBIGUOUS OUTCOME
 *
 * A request can commit on the server while its response never reaches the
 * browser (a dropped connection, the 15 s client timeout, a 5xx from a proxy
 * in front of the API). The frontend then cannot know whether the transaction
 * exists. Two things are safe in that situation and one is not:
 *
 *   SAFE  - replay the ORIGINAL request with the ORIGINAL key. The backend
 *           returns the record it created first, so nothing is duplicated.
 *   SAFE  - refuse to submit anything else until the situation is resolved.
 *   UNSAFE - submit a DIFFERENT payload, with a new key. That creates a second
 *           transaction: the original one may already exist.
 *
 * The holder below therefore keeps the original payload next to the key, and
 * refuses to start a different operation while an earlier one is unresolved.
 *
 * The signature of the payload is computed HERE, from the payload itself, and
 * never supplied by the caller. A caller-supplied signature could disagree
 * with the payload it is paired with, which would open a hole in the
 * "a different payload may not be submitted" rule.
 */
import { createIdempotencyStore, isValidIdempotencyRecord } from './idempotencyStore.js';
import { IDEMPOTENCY_RECORD_VERSION, IDEMPOTENCY_STATUS_UNRESOLVED } from './idempotencyConstants.js';

/**
 * Create a random v4 UUID.
 *
 * `crypto.randomUUID` is only available in a secure context, so it is not
 * available when the shop opens the frontend over plain HTTP on the LAN.
 * `crypto.getRandomValues` is available in every context, so it is used as the
 * fallback and the UUID is assembled by hand.
 *
 * When neither is available the request MUST NOT be sent: a predictable key
 * can collide with another transaction's key, and the backend would then
 * replay the wrong record and silently swallow the new transaction. Failing
 * closed keeps the shop's books correct.
 */
export function createIdempotencyKey() {
  const cryptoApi = globalThis.crypto;

  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }

  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-');
  }

  throw new Error(
    'This browser cannot generate secure random identifiers, so the request was not sent. ' +
      'Open the shop in a current browser or over HTTPS and try again.',
  );
}

/**
 * Validate a key before it is sent.
 *
 * The key is required for every money-writing request: sending the request
 * without one silently disables the protection and would let a retry create a
 * duplicate sale, purchase or payment, so a missing key fails loudly instead.
 */
export function requireIdempotencyKey(key, operation) {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error(`An Idempotency-Key is required for ${operation}.`);
  }
  return key.trim();
}

/**
 * HTTP statuses that are definitive for a money-writing workflow.
 *
 * The backend contract of every workflow was inspected:
 *
 *   POST /sales                  sale.controller    -> sale.service
 *   POST /purchases              purchase.controller -> purchase.service
 *   POST /suppliers/:id/payment  supplier.controller -> supplier.service
 *   POST /customers/:id/payment  khata.controller   -> khata.service
 *   POST /customers/:id/debt     khata.controller   -> khata.service
 *
 * In all five the write happens inside ONE Prisma transaction that rolls back
 * on any error, and every validation is raised BEFORE the first write or
 * inside that transaction:
 *
 *   sale.service      404 product / 404 customer, 400 insufficient stock and
 *                     400 zero KHATA total are raised before `sale.create`;
 *                     the invoice counter is incremented inside the same
 *                     transaction, so a failed sale consumes no invoice number.
 *   purchase.service  400 duplicate product ids, 404 supplier / 404 product,
 *                     400 invalid quantity / unit cost / total are raised
 *                     before `purchase.create`; a new product is created
 *                     inside the transaction and rolls back with it.
 *   supplier.service  400 invalid amount, 404 supplier, 400 no outstanding
 *                     balance and 400 payment above the balance are raised
 *                     before `supplierPayment.create` or inside the
 *                     transaction that created it; the allocations and the
 *                     balance update roll back with it.
 *   khata.service     400 invalid amount, 404 customer, 400 no outstanding
 *                     balance, 400 payment above the balance and 400 debt for
 *                     a retail customer are raised before the transaction row
 *                     is created; the 409 "balance changed" is raised inside
 *                     the transaction, which rolls the row back with it.
 *
 * The authentication middleware and the request validation run BEFORE the
 * controller, so a 401, a 403 and a schema 400 can never follow a write.
 *
 * A status that is not on this list is treated as AMBIGUOUS, because the
 * frontend cannot prove that nothing was committed.
 */
export const DEFAULT_DEFINITIVE_STATUSES = Object.freeze([
  400, // validation failed / insufficient stock / amount above the balance
  401, // not authenticated (the auth middleware runs before the controller)
  403, // account disabled (the auth middleware runs before the controller)
  404, // supplier / product / customer does not exist
  405, // method not allowed
  409, // unique violation, or a guarded write that matched no row
  410, // gone
  413, // payload too large
  415, // unsupported media type
  422, // unprocessable
  428, // precondition required
  429, // rate limited (rejected before the controller)
]);

/**
 * The definitive statuses of every money-writing workflow.
 *
 * They are listed per workflow, not shared, so the contract of each endpoint
 * is recorded where it is used. The five sets are identical today because the
 * five services share the "one transaction, validate before the first write"
 * shape described above; keeping them apart makes a future divergence in one
 * endpoint visible instead of silently changing the behaviour of all of them.
 */
export const DEFINITIVE_STATUSES_BY_OPERATION = Object.freeze({
  'POST /sales': Object.freeze([
    400, 401, 403, 404, 405, 409, 410, 413, 415, 422, 428, 429,
  ]),
  'POST /purchases': Object.freeze([
    400, 401, 403, 404, 405, 409, 410, 413, 415, 422, 428, 429,
  ]),
  'POST /suppliers/:id/payment': Object.freeze([
    400, 401, 403, 404, 405, 409, 410, 413, 415, 422, 428, 429,
  ]),
  'POST /customers/:id/payment': Object.freeze([
    400, 401, 403, 404, 405, 409, 410, 413, 415, 422, 428, 429,
  ]),
  'POST /customers/:id/debt': Object.freeze([
    400, 401, 403, 404, 405, 409, 410, 413, 415, 422, 428, 429,
  ]),
});

/** The definitive statuses of one workflow, or the default set. */
export function definitiveStatusesFor(operation) {
  if (typeof operation === 'string' && DEFINITIVE_STATUSES_BY_OPERATION[operation]) {
    return DEFINITIVE_STATUSES_BY_OPERATION[operation];
  }
  return DEFAULT_DEFINITIVE_STATUSES;
}

/**
 * Classify the outcome of a failed request.
 *
 * @param {Error} error - The rejection of the request.
 * @param {string} [operation] - The endpoint, e.g. `POST /sales`. It selects
 *   the definitive statuses of that endpoint's contract.
 * @returns {{ambiguous: boolean, reason: string, status: number|null, code: string|null}}
 */
export function classifyOutcome(error, operation) {
  const response = error?.response;

  // No HTTP response at all: the request left the browser but the answer
  // never came back (timeout, dropped connection, aborted request). The
  // server may well have committed it.
  if (!response) {
    return {
      ambiguous: true,
      reason: 'no-response',
      status: null,
      code: error?.code ?? null,
    };
  }

  const status = Number(response.status);

  if (!Number.isFinite(status) || status >= 500) {
    // A 5xx is not proof that the transaction rolled back: the error may have
    // been produced by a proxy after the database already committed.
    return {
      ambiguous: true,
      reason: 'server-error',
      status: Number.isFinite(status) ? status : null,
      code: error?.code ?? null,
    };
  }

  if (definitiveStatusesFor(operation).includes(status)) {
    return {
      ambiguous: false,
      reason: 'client-error',
      status,
      code: error?.code ?? null,
    };
  }

  return {
    ambiguous: true,
    reason: 'unknown-status',
    status: Number.isFinite(status) ? status : null,
    code: error?.code ?? null,
  };
}

/**
 * Normalise a payload so the copy that is stored and the copy that is sent
 * are byte for byte the same. `undefined` members are dropped and dates
 * become ISO strings, exactly like `JSON.stringify` would do on the wire.
 */
export function normalizePayload(payload) {
  if (payload === null || typeof payload !== 'object') return payload;
  try {
    return JSON.parse(JSON.stringify(payload));
  } catch {
    return payload;
  }
}

/** Sort the keys of every object, recursively. */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * The canonical form of a payload: the JSON text with every object key in
 * sorted order.
 *
 * Two payloads have the same canonical form exactly when they would produce
 * the same request. The canonical form is used as the signature of the
 * payload, so "is this the same request?" is answered by comparing the
 * signature - never by trusting a value the caller supplied.
 */
export function canonicalize(payload) {
  try {
    return JSON.stringify(sortDeep(normalizePayload(payload)));
  } catch {
    return '';
  }
}

/** True when the payload can be persisted and replayed. */
function isReplayablePayload(payload) {
  return Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload);
}

/**
 * A state machine that owns the key AND the payload of one logical
 * submission. It is framework agnostic so the rules can be unit tested
 * without a React renderer; `useMoneyOperation` wraps it.
 *
 * Every operation is scoped. Two components that write the same kind of
 * record for the same entity share a scope (for example a manual debt entry
 * for customer 12), so they also share the unresolved state and cannot create
 * two debts while the first one is unresolved.
 *
 *   begin(scope, payload)
 *       Starts a new operation, or replays an unresolved one. Returns
 *       `{ blocked: true }` when an unresolved operation exists with a
 *       DIFFERENT payload - the caller must not send anything. Returns
 *       `null` while a request is already in flight.
 *   replay(scope)
 *       Returns the stored key and payload of an unresolved operation so the
 *       original request can be sent again, unchanged.
 *   succeed(scope)
 *       The response was definitive: forget the operation completely.
 *   fail(scope, { ambiguous })
 *       An ambiguous outcome keeps the key and the payload and persists them,
 *       so the original request can still be replayed. A definitive outcome
 *       releases them: nothing was created, so the next submission is a new
 *       operation.
 *   abandon(scope)
 *       The user explicitly decided to start something else. The original
 *       request may still have been committed - this never undoes it.
 */
export function createIdempotencyKeyHolder({ store = createIdempotencyStore() } = {}) {
  const states = new Map();

  function stateFor(scope) {
    let state = states.get(scope);
    if (!state) {
      const record = store.read(scope);
      state = {
        key: record ? record.key : null,
        signature: record ? record.signature : null,
        payload: record ? record.payload : null,
        entity: record ? record.entity ?? null : null,
        createdAt: record ? record.createdAt : null,
        pending: false,
      };
      states.set(scope, state);
    }
    return state;
  }

  /** Adopt the persisted state, so another tab/page cannot act stale. */
  function refresh(scope) {
    const state = stateFor(scope);
    const record = store.read(scope);

    if (record && isValidIdempotencyRecord(record, scope)) {
      state.key = record.key;
      state.signature = record.signature;
      state.payload = record.payload;
      state.entity = record.entity ?? null;
      state.createdAt = record.createdAt;
    } else if (!state.pending) {
      state.key = null;
      state.signature = null;
      state.payload = null;
      state.entity = null;
      state.createdAt = null;
    }

    return state;
  }

  function persist(scope, state) {
    if (!state.key || !state.payload) {
      store.remove(scope);
      return false;
    }

    return store.write(scope, {
      v: IDEMPOTENCY_RECORD_VERSION,
      scope,
      key: state.key,
      signature: state.signature,
      payload: state.payload,
      entity: state.entity ?? null,
      status: IDEMPOTENCY_STATUS_UNRESOLVED,
      createdAt: state.createdAt,
    });
  }

  function clear(state) {
    state.key = null;
    state.signature = null;
    state.payload = null;
    state.entity = null;
    state.createdAt = null;
    state.pending = false;
  }

  return {
    /** The unresolved operation of a scope, or null. */
    peek(scope) {
      const state = refresh(scope);
      if (!state.key || !state.payload) return null;
      return {
        scope,
        key: state.key,
        signature: state.signature,
        payload: state.payload,
        entity: state.entity ?? null,
        createdAt: state.createdAt,
      };
    },

    /** True while a request of this scope is in flight. */
    isPending(scope) {
      return stateFor(scope).pending === true;
    },

    /**
     * Start an operation or replay an unresolved one.
     *
     * @param {string} scope - The scope of the operation.
     * @param {object} payload - The request body. It is normalised once, so
     *   the copy that is stored and the copy that is sent are identical.
     * @param {string|number|null} [entity] - The customer/supplier the
     *   request targets. It is stored with the operation so a retry can
     *   rebuild the URL of the request.
     * @returns {null | {blocked: boolean, replay: boolean, key: string, payload: object, signature: string, entity: string|null}}
     */
    begin(scope, payload, entity = null) {
      const state = refresh(scope);

      if (state.pending) return null;

      const normalized = normalizePayload(payload);

      if (!isReplayablePayload(normalized)) {
        // Without a payload that can be persisted and replayed, the safety
        // guarantee does not hold, so the request must not be sent.
        throw new Error(
          'The request payload could not be stored for a safe retry, so the request was not sent.',
        );
      }

      const signature = canonicalize(normalized);

      if (state.key && state.payload) {
        // An earlier request of this scope may already have been committed.
        if (state.signature !== signature) {
          return {
            blocked: true,
            reason: 'unresolved-operation',
            unresolved: {
              scope,
              key: state.key,
              signature: state.signature,
              payload: state.payload,
              entity: state.entity ?? null,
              createdAt: state.createdAt,
            },
          };
        }

        // Same request: replay it with the original key and payload.
        state.pending = true;
        return {
          blocked: false,
          replay: true,
          key: state.key,
          payload: state.payload,
          signature: state.signature,
          entity: state.entity ?? null,
        };
      }

      // A genuinely new operation. The payload is normalised once so the
      // copy that is sent and the copy that is stored are identical.
      state.key = createIdempotencyKey(); // throws when no secure randomness exists
      state.signature = signature;
      state.payload = normalized;
      state.entity = entity === null || entity === undefined ? null : String(entity);
      state.createdAt = new Date().toISOString();
      state.pending = true;

      if (!persist(scope, state)) {
        // The request cannot be recovered after a reload, so it is not sent.
        clear(state);
        throw new Error(
          'The request could not be stored for a safe retry, so the request was not sent.',
        );
      }

      return {
        blocked: false,
        replay: false,
        key: state.key,
        payload: normalized,
        signature,
        entity: state.entity,
      };
    },

    /** The stored key and payload of an unresolved operation, for a retry. */
    replay(scope) {
      const state = refresh(scope);
      if (state.pending) return null;
      if (!state.key || !state.payload) return null;
      state.pending = true;
      return {
        key: state.key,
        payload: state.payload,
        signature: state.signature,
        entity: state.entity ?? null,
      };
    },

    /** The request was confirmed: forget the operation completely. */
    succeed(scope) {
      const state = stateFor(scope);
      clear(state);
      store.remove(scope);
    },

    /**
     * The request failed.
     *
     * @param {boolean} ambiguous - true when the outcome is unknown and the
     *   request may already have been committed.
     */
    fail(scope, { ambiguous }) {
      const state = stateFor(scope);
      state.pending = false;

      if (ambiguous) {
        // Keep the key and the payload so the original request can be
        // replayed, and persist them so a reload cannot lose them.
        persist(scope, state);
        return;
      }

      // A definitive failure created nothing, so the key is released and the
      // next submission is a new operation.
      clear(state);
      store.remove(scope);
    },

    /**
     * The user explicitly started something else. The original request may
     * still have been committed - this does not undo it.
     */
    abandon(scope) {
      const state = stateFor(scope);
      clear(state);
      store.remove(scope);
    },

    /** Every scope that currently holds an unresolved operation. */
    listUnresolved() {
      return store
        .listScopes()
        .map((scope) => this.peek(scope))
        .filter(Boolean);
    },
  };
}

export default {
  createIdempotencyKey,
  requireIdempotencyKey,
  classifyOutcome,
  normalizePayload,
  canonicalize,
  createIdempotencyKeyHolder,
  DEFAULT_DEFINITIVE_STATUSES,
  DEFINITIVE_STATUSES_BY_OPERATION,
  definitiveStatusesFor,
};
