import { useCallback, useState, useSyncExternalStore } from 'react';
import { createMoneyOperation, listUnresolvedOperations } from '../utils/moneyOperation.js';
import { getSharedIdempotencyStore } from './useMoneyOperation.js';

/**
 * The unresolved money-writing operations of one workflow.
 *
 * The list is derived from the shared store, so it stays correct when
 * another page of the shop leaves an operation behind, and when the user
 * navigates away and comes back.
 *
 * @param {object} options
 * @param {string} options.workflow - The scope prefix, e.g. `customer-debt`.
 *   Operations of `customer-debt:12` belong to the workflow `customer-debt`.
 * @param {string} options.operation - The endpoint, e.g. `POST /customers/:id/debt`.
 * @param {string} options.label - The human name of the transaction.
 * @param {Function} options.send - `async (body, key, entity) => result`.
 * @param {string|number|null} [options.entity] - When given, only the
 *   operations of that entity are listed.
 *
 * @returns {{records: object[], busy: boolean, retry: Function, abandon: Function}}
 */
export function useUnresolvedOperations({ workflow, operation, label, send, entity = null }) {
  const store = getSharedIdempotencyStore();
  // The subscription re-renders the component whenever a record is written or
  // removed, so the list is always the current one.
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  const [busy, setBusy] = useState(false);

  const records = listUnresolvedOperations(store).filter(
    (record) =>
      (record.scope === workflow || record.scope.startsWith(`${workflow}:`)) &&
      (entity === null || entity === undefined || record.entity === String(entity)),
  );

  /**
   * Replay an unresolved request.
   *
   * A dedicated controller is created for the scope of the record, so the
   * retry uses the stored body and the stored key - never the state of a form
   * that may have been edited in the meantime.
   */
  const retry = useCallback(
    async (scope) => {
      setBusy(true);
      try {
        const controller = createMoneyOperation({ scope, operation, label, send, store });
        return await controller.retry();
      } finally {
        setBusy(false);
      }
    },
    [operation, label, send, setBusy, store],
  );

  /**
   * Explicitly start something else. The original request may still have
   * been committed - this does not undo it.
   */
  const abandon = useCallback(
    (scope) => {
      const controller = createMoneyOperation({ scope, operation, label, send, store });
      controller.abandon();
    },
    [operation, label, send, store],
  );

  return { records, busy, retry, abandon };
}

export default useUnresolvedOperations;
