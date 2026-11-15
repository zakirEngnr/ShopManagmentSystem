/**
 * Running-balance helpers for the KHATA (customer ledger) view.
 *
 * The ledger API returns the rows in BACKEND order: newest first
 * (`ORDER BY createdAt DESC, id DESC`).
 *
 * `customer.balance` is the authoritative CURRENT balance, i.e. the balance
 * after every transaction that exists. The historical balances are derived
 * from it by walking the transactions backwards, newest first, and undoing
 * each transaction's effect. That way the newest row always shows exactly
 * `customer.balance`.
 */

/**
 * The signed effect of one ledger transaction on the customer balance.
 *
 * This mirrors the backend:
 *   - `recordSale()`    -> `customer.balance += amount`  (SALE)
 *   - `recordPayment()` -> `customer.balance -= amount`  (PAYMENT)
 *   - `recordDebt()`    -> `customer.balance += amount`  (DEBT)
 *
 * Every other type (for example a legacy ADJUSTMENT row) increases the
 * balance, which is what the ledger view has always assumed.
 */
export function getTransactionBalanceEffect(transaction) {
  const amount = Number(transaction?.amount ?? 0);
  if (!Number.isFinite(amount)) return 0;
  return transaction?.type === 'PAYMENT' ? -amount : amount;
}

/**
 * The net effect of a list of ledger transactions on the balance.
 */
export function netBalanceEffect(transactions) {
  if (!Array.isArray(transactions)) return 0;
  return transactions.reduce((sum, transaction) => sum + getTransactionBalanceEffect(transaction), 0);
}

/**
 * Compute the running balance for a page of ledger transactions.
 *
 * @param {Array} transactions - Ledger rows in backend order (newest first).
 * @param {number} anchorBalance - The balance AFTER the newest transaction of
 *   `transactions`. For the newest page this is `customer.balance`; for an
 *   older page it is that page's own anchor, because the transactions of the
 *   newer pages are not part of the list.
 * @returns {Array} The same rows, in the same order, each with a `before` and
 *   an `after` balance.
 */
export function computeRunningBalances(transactions, anchorBalance) {
  if (!Array.isArray(transactions)) return [];

  const anchor = Number(anchorBalance ?? 0);
  const start = Number.isFinite(anchor) ? anchor : 0;

  return transactions.reduce(
    (acc, transaction) => {
      const effect = getTransactionBalanceEffect(transaction);
      const after = acc.balance;
      const before = after - effect;
      acc.rows.push({ ...transaction, before, after });
      acc.balance = before;
      return acc;
    },
    { balance: start, rows: [] },
  ).rows;
}

/**
 * The anchor balance of a ledger page.
 *
 * The anchor of the newest page is the customer's current balance. The anchor
 * of an older page is that balance minus the net effect of every transaction
 * that is newer than the page, because those transactions are not part of the
 * page but still change the balance.
 *
 * @param {number} currentBalance - `customer.balance`.
 * @param {number} newerEffect - Net effect of the transactions that are newer
 *   than the page (0 for the newest page).
 */
export function computePageAnchor(currentBalance, newerEffect = 0) {
  const current = Number(currentBalance ?? 0);
  const effect = Number(newerEffect ?? 0);
  if (!Number.isFinite(current)) return 0;
  if (!Number.isFinite(effect)) return current;
  return current - effect;
}

export default {
  getTransactionBalanceEffect,
  netBalanceEffect,
  computeRunningBalances,
  computePageAnchor,
};
