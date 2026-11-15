/**
 * Money helpers for the frontend.
 *
 * Every amount is handled as INTEGER PAISA (1 rupee = 100 paisa) before it is
 * compared or subtracted, so a difference of one paisa is exact and no
 * floating point residue can creep into a comparison or into the change that
 * is handed back to the customer.
 *
 * These helpers are the single place where the frontend converts between
 * rupees and paisa. Components must not re-implement the conversion.
 */

/**
 * Convert rupees to integer paisa.
 *
 * A value that is not a finite number is treated as 0: the caller has to
 * validate the user input before it becomes an amount.
 *
 * @param {number|string|null|undefined} rupees
 * @returns {number} the amount in integer paisa.
 */
export function toPaisa(rupees) {
  if (rupees === null || rupees === undefined || rupees === '') return 0;
  const value = Number(rupees);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

/**
 * Convert integer paisa to rupees.
 *
 * @param {number} paisa
 * @returns {number} the amount in rupees.
 */
export function fromPaisa(paisa) {
  return paisa / 100;
}

/**
 * Convert rupees to a display string.
 *
 * @param {number} rupees
 * @returns {string} e.g. "1234.5"
 */
export function toRupees(paisa) {
  return fromPaisa(paisa);
}

/**
 * Format an amount in paisa as a currency string with exactly two decimals.
 *
 * An exact payment therefore reads "Rs. 0.00" and an overpayment of one
 * paisa reads "Rs. 0.01".
 *
 * @param {number} paisa
 * @returns {string} e.g. "Rs. 1,234.00"
 */
export function formatPaisa(paisa) {
  const value = fromPaisa(Number.isFinite(paisa) ? paisa : 0);
  return `Rs. ${value.toLocaleString('en-PK', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default { toPaisa, fromPaisa, toRupees, formatPaisa };
