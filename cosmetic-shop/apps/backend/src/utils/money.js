import { z } from 'zod';

/**
 * Money math utilities.
 *
 * All monetary values are stored as Float rupees in the database (Phase A:
 * no schema migration). Internally we convert to integer paisa (1 rupee =
 * 100 paisa) for addition, subtraction, and multiplication, then convert
 * back to rupees rounded to 2 decimal places. This avoids float residue
 * such as 0.0000001 accumulating across many operations.
 */

/** Convert rupees to integer paisa. */
export function toPaisa(rupees) {
  if (!Number.isFinite(rupees)) {
    throw new Error('toPaisa: value must be a finite number');
  }
  return Math.round(rupees * 100);
}

/** Convert integer paisa to rupees. */
export function fromPaisa(paisa) {
  if (!Number.isInteger(paisa)) {
    throw new Error('fromPaisa: paisa must be an integer');
  }
  return paisa / 100;
}

/**
 * Add two rupee amounts using integer paisa arithmetic.
 * Returns rupees rounded to 2 decimal places.
 */
export function add(a, b) {
  return fromPaisa(toPaisa(a) + toPaisa(b));
}

/**
 * Subtract two rupee amounts using integer paisa arithmetic.
 * Returns rupees rounded to 2 decimal places.
 */
export function subtract(a, b) {
  return fromPaisa(toPaisa(a) - toPaisa(b));
}

/**
 * Multiply a unit price by a quantity using integer paisa arithmetic.
 * Returns rupees rounded to 2 decimal places.
 */
export function multiply(unitPrice, qty) {
  if (!Number.isInteger(qty) || qty < 1) {
    throw new Error('multiply: qty must be a positive integer');
  }
  return fromPaisa(toPaisa(unitPrice) * qty);
}

/**
 * Zod helper: returns a base ZodNumber that requires a finite value.
 * Chain with `.min()`, `.max()`, `.default()`, etc. before applying
 * `withTwoDecimals()` (which adds the <=2 decimal places check via refine).
 *
 * Rejection message for invalid decimals: "Amount can have at most 2 decimal places".
 * Do NOT use string splitting or regex on String(value).
 */
export function moneyAmount() {
  return z
    .number()
    .finite({ message: 'Amount can have at most 2 decimal places' });
}

const MAX_DECIMALS_MESSAGE = 'Amount can have at most 2 decimal places';

function checkTwoDecimals(value) {
  const scaled = value * 100;
  const rounded = Math.round(scaled);
  return (
    Number.isInteger(rounded) &&
    Math.abs(scaled - rounded) < 1e-9
  );
}

/**
 * Zod schema transformer: adds an "at most 2 decimal places" refinement to a
 * ZodNumber schema. Returns a refined schema (call this LAST in the chain).
 */
export function withTwoDecimals(schema) {
  return schema.refine(checkTwoDecimals, { message: MAX_DECIMALS_MESSAGE });
}

/** Round a rupee value to 2 decimal places (safe display/output helper). */
export function round2(value) {
  return Number(value.toFixed(2));
}

export default {
  toPaisa,
  fromPaisa,
  add,
  subtract,
  multiply,
  moneyAmount,
  round2,
};
