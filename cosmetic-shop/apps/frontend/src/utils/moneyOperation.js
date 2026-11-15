/**
 * The money-operation controller: one implementation of the "may this
 * request be sent?" rules, shared by all five money-writing workflows.
 *
 *   POST /sales                  (POS, including KHATA)
 *   POST /purchases
 *   POST /suppliers/:id/payment
 *   POST /customers/:id/payment
 *   POST /customers/:id/debt
 *
 * WHY A CONTROLLER
 *
 * The rules below are the difference between one transaction and two. They
 * were copy-pasted into five pages before, and a copy that forgets one rule
 * is a copy that can duplicate a transaction. The controller is framework
 * agnostic, so the rules can be tested against a REAL backend and a
 * disposable database without a browser.
 *
 * THE RULES
 *
 *   1. A request carries an idempotency key and the EXACT body that was
 *      stored with it. The body is never rebuilt from the form.
 *   2. While an operation is unresolved the original body and key are kept,
 *      the body may not be edited and a DIFFERENT body may not be sent.
 *   3. A retry sends the stored body and the stored key. The backend then
 *      replays the original transaction instead of creating a second one.
 *   4. A network failure, a timeout or a 5xx is AMBIGUOUS: the request may
 *      have been committed, so the operation stays unresolved.
 *   5. A verified 4xx is DEFINITIVE: nothing was committed, so the key is
 *      released and the next submission is a new operation.
 *   6. Without secure randomness the request is NOT sent.
 */
import { classifyOutcome, createIdempotencyKeyHolder } from './idempotency.js';
import { createIdempotencyStore } from './idempotencyStore.js';

/** The possible results of `submit()` and `retry()`. */
export const MONEY_OUTCOME = Object.freeze({
  /** The server confirmed the transaction. */
  SENT: 'sent',
  /** An unresolved operation exists with a different body: nothing was sent. */
  BLOCKED: 'blocked',
  /** The outcome is unknown: the transaction MAY already have been saved. */
  AMBIGUOUS: 'ambiguous',
  /** A verified failure: nothing was committed. */
  FAILED: 'failed',
  /** A request of this scope is already in flight. */
  BUSY: 'busy',
  /** The request was not sent at all (no secure randomness, not persistable). */
  UNSAFE: 'unsafe',
  /** There is nothing to retry. */
  UNAVAILABLE: 'unavailable',
});

/** The message shown when the outcome is unknown. */
export function ambiguousMessage(label) {
  return `The request was sent but no confirmation came back. This ${label} may already have been saved.`;
}

/** The message shown when a different body was refused. */
export function blockedMessage(label) {
  return `A previous ${label} is unresolved and may already have been saved. Retry it or start a new ${label}.`;
}

/** The message shown when the browser cannot produce a safe key. */
export function unsafeMessage(error) {
  return error?.message || 'The request could not be sent safely.';
}

/** The message shown when the server rejected the request for a known reason. */
export function failureMessage(error, label, fallback) {
  const fromServer = error?.response?.data?.error?.message;
  if (typeof fromServer === 'string' && fromServer.trim() !== '') return fromServer;
  if (typeof error?.message === 'string' && error.message.trim() !== '') return error.message;
  if (typeof fallback === 'string' && fallback.trim() !== '') return fallback;
  return `Failed to save the ${label}.`;
}

/* ------------------------------------------------------------------ */
/* the abandonment confirmation                                         */
/* ------------------------------------------------------------------ */

/** The abandonment has not been requested yet. */
export const ABANDON_IDLE = 'idle';
/** The abandonment was requested and waits for the second, explicit action. */
export const ABANDON_CONFIRMING = 'confirming';

/**
 * The state of the two step abandonment.
 *
 * Throwing away the only record that a request is still unresolved must
 * never be a single click. The first action asks for the confirmation, the
 * second one carries it out.
 *
 * @param {{status: string, key: string|null}} state
 * @param {{type: string, key?: string}} action
 * @returns {{status: string, key: string|null}}
 */
export function abandonConfirmationReducer(state, action) {
  switch (action?.type) {
    case 'request':
      return { status: ABANDON_CONFIRMING, key: action.key ?? null };
    case 'cancel':
    case 'confirm':
      return { status: ABANDON_IDLE, key: null };
    default:
      return state;
  }
}

/** True when the confirmation of this key is on screen. */
export function isAbandonConfirming(state, key) {
  return state?.status === ABANDON_CONFIRMING && state?.key !== null && state?.key === key;
}

/**
 * Create the controller of one money-writing operation.
 *
 * @param {object} options
 * @param {string} options.scope - Identifies the operation, e.g. `sale` or
 *   `customer-debt:12`. Two components that write the same record for the
 *   same entity must use the same scope.
 * @param {string} options.operation - The endpoint, e.g. `POST /sales`. It
 *   selects the definitive HTTP statuses of that endpoint's contract.
 * @param {string} options.label - The human name of the transaction, used in
 *   the messages, e.g. `sale`.
 * @param {Function} options.send - `async (body, key, entity) => result`. It
 *   must put `body` on the wire unchanged and target `entity`.
 * @param {object} [options.store] - The durable store. One store is shared
 *   by the whole tab, so two pages share the unresolved state of an operation.
 */
export function createMoneyOperation({
  scope,
  operation,
  label,
  send,
  store = createIdempotencyStore(),
}) {
  const holder = createIdempotencyKeyHolder({ store });

  const config = { scope, operation, label, send };

  /** Update the configuration; the scope changes when the target changes. */
  function configure(next) {
    if (next.scope !== undefined) config.scope = next.scope;
    if (next.operation !== undefined) config.operation = next.operation;
    if (next.label !== undefined) config.label = next.label;
    if (next.send !== undefined) config.send = next.send;
    return config;
  }

  /** Send a body with a key and settle the operation according to the result. */
  async function sendAndSettle(scope, operation, body, key, entity) {
    try {
      const result = await config.send(body, key, entity);

      // The server confirmed the transaction: the persisted state and the
      // in-memory holder are cleared, so the next one is a new operation.
      //
      // The scope of the operation is captured when the request STARTS, not
      // when it finishes. The user can change the target (another customer,
      // another supplier) while the request is in flight; settling on the
      // current scope would clear the state of a DIFFERENT operation.
      holder.succeed(scope);

      return {
        outcome: MONEY_OUTCOME.SENT,
        result,
        body,
        key,
        entity,
        message: null,
        error: null,
      };
    } catch (error) {
      const classification = classifyOutcome(error, operation);

      if (classification.ambiguous) {
        // The transaction MAY already have been committed. Keep the key AND
        // the body so the original request can be replayed unchanged.
        holder.fail(scope, { ambiguous: true });
        return {
          outcome: MONEY_OUTCOME.AMBIGUOUS,
          result: null,
          body,
          key,
          entity,
          message: ambiguousMessage(config.label),
          error,
        };
      }

      // A verified failure created nothing, so the key is released.
      holder.fail(scope, { ambiguous: false });
      return {
        outcome: MONEY_OUTCOME.FAILED,
        result: null,
        body,
        key,
        entity,
        message: failureMessage(error, config.label),
        error,
      };
    }
  }

  return {
    configure,

    /** The scope the controller currently works on. */
    get scope() {
      return config.scope;
    },

    /** The unresolved operation of this scope, or null. */
    getUnresolved() {
      return holder.peek(config.scope);
    },

    /** True while a request of this scope is in flight. */
    isPending() {
      return holder.isPending(config.scope);
    },

    /** True while the operation may not be edited or replaced. */
    isLocked() {
      return holder.peek(config.scope) !== null;
    },

    /**
     * Send a request.
     *
     * @param {object} body - The request body. It is stored with the key and
     *   sent unchanged.
     * @param {string|number|null} [entity] - The customer/supplier the
     *   request targets. It is stored with the operation so a retry can
     *   rebuild the URL of the request.
     * @returns {Promise<object>} One of the `MONEY_OUTCOME` results.
     */
    async submit(body, entity = null) {
      // The scope and the endpoint are captured here: the user can change
      // the target while the request is in flight.
      const scope = config.scope;
      const operation = config.operation;
      let submission = null;

      try {
        submission = holder.begin(scope, body, entity);
      } catch (error) {
        // No secure randomness, or a payload that cannot be persisted: the
        // request was NOT sent, so nothing is unresolved.
        return {
          outcome: MONEY_OUTCOME.UNSAFE,
          result: null,
          body: null,
          key: null,
          entity: null,
          message: unsafeMessage(error),
          error,
        };
      }

      if (!submission) {
        // A request of this scope is already in flight.
        return {
          outcome: MONEY_OUTCOME.BUSY,
          result: null,
          body: null,
          key: null,
          entity: null,
          message: `The ${config.label} is already being submitted.`,
          error: null,
        };
      }

      if (submission.blocked) {
        // An earlier request of this scope may already have been committed,
        // so nothing else may be sent.
        return {
          outcome: MONEY_OUTCOME.BLOCKED,
          result: null,
          body: null,
          key: null,
          entity: submission.unresolved?.entity ?? null,
          message: blockedMessage(config.label),
          unresolved: submission.unresolved,
          error: null,
        };
      }

      // The stored body is sent, never the caller's body: a replay must be
      // byte for byte the request that may already have been committed.
      return sendAndSettle(scope, operation, submission.payload, submission.key, submission.entity);
    },

    /**
     * Send the ORIGINAL request again, unchanged.
     *
     * @returns {Promise<object>} One of the `MONEY_OUTCOME` results.
     */
    async retry() {
      const scope = config.scope;
      const operation = config.operation;
      const submission = holder.replay(scope);

      if (!submission) {
        return {
          outcome: MONEY_OUTCOME.UNAVAILABLE,
          result: null,
          body: null,
          key: null,
          entity: null,
          message: `There is no unresolved ${config.label} to retry.`,
          error: null,
        };
      }

      return sendAndSettle(scope, operation, submission.payload, submission.key, submission.entity);
    },

    /**
     * The user explicitly decided to start something else. The original
     * request may still have been committed - this does not undo it.
     */
    abandon() {
      holder.abandon(config.scope);
    },
  };
}

/**
 * Every unresolved operation of the tab, across all scopes.
 *
 * The pages use this for the page level warning: an unresolved operation
 * whose dialog is not open must still be visible, for example a manual debt
 * entry for a customer the user navigated away from.
 */
export function listUnresolvedOperations(store) {
  return store
    .listScopes()
    .map((scope) => {
      const record = store.read(scope);
      return record ? { ...record } : null;
    })
    .filter(Boolean);
}

export default {
  MONEY_OUTCOME,
  createMoneyOperation,
  listUnresolvedOperations,
  ambiguousMessage,
  blockedMessage,
  failureMessage,
  abandonConfirmationReducer,
  isAbandonConfirming,
  ABANDON_IDLE,
  ABANDON_CONFIRMING,
};
