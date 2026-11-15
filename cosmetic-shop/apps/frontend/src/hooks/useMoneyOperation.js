import { useCallback, useReducer, useState } from 'react';
import { createMoneyOperation } from '../utils/moneyOperation.js';
import { createIdempotencyStore } from '../utils/idempotencyStore.js';

let sharedStore = null;

/**
 * One store for the whole tab, so two pages that write the same kind of
 * record for the same entity (a manual debt entry for the same customer, for
 * example) share the unresolved state.
 */
export function getSharedIdempotencyStore() {
  if (!sharedStore) sharedStore = createIdempotencyStore();
  return sharedStore;
}

/** Forget the shared store. Used by the tests to isolate each case. */
export function resetSharedIdempotencyStore() {
  sharedStore = null;
}

/**
 * React binding for one money-writing operation.
 *
 * @param {object} options
 * @param {string} options.scope - Identifies the operation, e.g. `sale` or
 *   `customer-debt:12`. Two components that write the same record for the
 *   same entity must use the same scope.
 * @param {string} options.operation - The endpoint, e.g. `POST /sales`.
 * @param {string} options.label - The human name of the transaction, e.g.
 *   `sale`. It is used in the messages.
 * @param {Function} options.send - `async (body, key) => result`. It must put
 *   `body` on the wire unchanged.
 *
 * @returns {{
 *   scope: string,
 *   unresolved: object | null,
 *   pending: boolean,
 *   locked: boolean,
 *   outcome: object | null,
 *   submit: (body: object) => Promise<object>,
 *   retry: () => Promise<object>,
 *   abandon: () => void,
 * }}
 */
export function useMoneyOperation({ scope, operation, label, send }) {
  const [controller] = useState(
    () => createMoneyOperation({ scope, operation, label, send, store: getSharedIdempotencyStore() }),
  );

  const [, rerender] = useReducer((n) => n + 1, 0);
  const [outcome, setOutcome] = useState(null);

  // The scope changes when the user picks another customer or supplier, so
  // the controller is kept in sync with the current target.
  controller.configure({ scope, operation, label, send });

  const submit = useCallback(
    async (body) => {
      const result = await controller.submit(body);
      setOutcome(result);
      rerender();
      return result;
    },
    [controller],
  );

  const retry = useCallback(async () => {
    const result = await controller.retry();
    setOutcome(result);
    rerender();
    return result;
  }, [controller]);

  const abandon = useCallback(() => {
    controller.abandon();
    setOutcome(null);
    rerender();
  }, [controller]);

  // The unresolved operation is derived from the holder, so it is always in
  // sync with the persisted state - even after a remount or when another
  // page left an operation behind.
  const unresolved = controller.getUnresolved();

  return {
    scope,
    unresolved,
    pending: controller.isPending(),
    locked: unresolved !== null,
    outcome,
    submit,
    retry,
    abandon,
  };
}

export default useMoneyOperation;
