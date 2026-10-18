import { INVOICE_PREFIX } from '../config/constants.js';

/**
 * Builds an invoice number from a year + sequence.
 * The actual sequence lookup is done in the sale service,
 * which knows how many sales exist for the year.
 *
 * @param {number} year
 * @param {number} sequence  (1-based)
 * @returns {string}  e.g. "INV-2026-0001"
 */
export function formatInvoiceNo(year, sequence) {
  const seq = String(sequence).padStart(4, '0');
  return `${INVOICE_PREFIX}-${year}-${seq}`;
}

export default { formatInvoiceNo };
