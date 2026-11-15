/**
 * The cash tender rules of the POS.
 *
 * The cashier enters what the customer handed over. The tender is validated
 * and the change is derived in INTEGER PAISA, so:
 *
 *   * an exact payment produces exactly 0.00 of change;
 *   * an overpayment produces the correct change to the paisa;
 *   * a one-paisa shortfall is detected instead of being rounded away.
 *
 * The tender never replaces the sale total: the total is what the customer
 * owes and the tender is only what they handed over.
 */
import { toPaisa, fromPaisa } from './money.js';

/**
 * Validate the cash tender entered at the POS.
 *
 * @param {string|number|null|undefined} rawTender - what the cashier typed.
 * @param {number} payablePaisa - the amount due, in integer paisa.
 * @returns {string|null} an error message, or null when the tender is valid.
 */
export function validateCashTender(rawTender, payablePaisa) {
  const text = typeof rawTender === 'string' ? rawTender.trim() : rawTender;

  // An empty field is NOT zero: the cashier has not entered anything yet.
  if (text === '' || text === null || text === undefined) {
    return 'Enter the cash received.';
  }

  const value = Number(text);
  if (!Number.isFinite(value)) {
    return 'Cash received must be a valid number.';
  }
  if (value < 0) {
    return 'Cash received must not be negative.';
  }

  const tenderPaisa = toPaisa(value);
  if (tenderPaisa < payablePaisa) {
    return `Cash received (Rs. ${fromPaisa(tenderPaisa).toFixed(2)}) is less than the total (Rs. ${fromPaisa(payablePaisa).toFixed(2)}).`;
  }

  return null;
}

/**
 * The change to hand back, in integer paisa.
 *
 * The tender is rejected by `validateCashTender` before this is called, so
 * the result is never negative here: a tender below the total yields 0.
 *
 * @param {string|number|null|undefined} rawTender - what the cashier typed.
 * @param {number} payablePaisa - the amount due, in integer paisa.
 * @returns {number} the change in integer paisa.
 */
export function changePaisa(rawTender, payablePaisa) {
  const text = typeof rawTender === 'string' ? rawTender.trim() : rawTender;
  if (text === '' || text === null || text === undefined) return 0;
  const value = Number(text);
  if (!Number.isFinite(value)) return 0;
  const tenderPaisa = toPaisa(value);
  return tenderPaisa > payablePaisa ? tenderPaisa - payablePaisa : 0;
}

/**
 * The change of a sale that the server confirmed.
 *
 * The sale is the authority: the change is derived from the tender the
 * server stored and the total the server computed, so an idempotent retry
 * shows exactly the same change as the original sale.
 *
 * @param {object|null|undefined} sale - the sale returned by the server.
 * @returns {number|null} the change in integer paisa, or null when the sale
 *   was not paid in cash.
 */
export function changeFromSale(sale) {
  if (!sale) return null;
  const tender = sale.cashReceived;
  if (tender === null || tender === undefined) return null;
  return toPaisa(tender) - toPaisa(sale.total);
}

export default { validateCashTender, changePaisa, changeFromSale };
