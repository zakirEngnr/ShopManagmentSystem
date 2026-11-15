// Behavioural tests for the cash tender of the POS.
//
// The tender is validated and the change is derived in INTEGER PAISA, so an
// exact payment is exactly 0.00 of change and a one-paisa shortfall is
// detected instead of being rounded away.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toPaisa, fromPaisa, formatPaisa } from '../src/utils/money.js';
import { validateCashTender, changePaisa, changeFromSale } from '../src/utils/cashTender.js';

/* ------------------------------------------------------------------ */
/* The money helpers                                                    */
/* ------------------------------------------------------------------ */

test('toPaisa converts rupees to integer paisa', () => {
  assert.equal(toPaisa(10), 1000);
  assert.equal(toPaisa(19.99), 1999);
  assert.equal(toPaisa(0.1), 10, 'a tenth of a rupee is ten paisa');
  assert.equal(toPaisa(0), 0);
  assert.equal(toPaisa(null), 0);
  assert.equal(toPaisa(undefined), 0);
  assert.equal(toPaisa(''), 0);
  assert.equal(toPaisa('abc'), 0);
  assert.equal(toPaisa(Infinity), 0);
});

test('fromPaisa converts integer paisa back to rupees', () => {
  assert.equal(fromPaisa(1000), 10);
  assert.equal(fromPaisa(1999), 19.99);
  assert.equal(fromPaisa(0), 0);
});

test('formatPaisa always shows two decimals', () => {
  assert.equal(formatPaisa(0), 'Rs. 0.00', 'an exact payment reads Rs. 0.00');
  assert.equal(formatPaisa(1), 'Rs. 0.01', 'one paisa of change reads Rs. 0.01');
  assert.equal(formatPaisa(3000), 'Rs. 30.00');
  assert.equal(formatPaisa(123456), 'Rs. 1,234.56');
});

/* ------------------------------------------------------------------ */
/* Validating the tender                                                */
/* ------------------------------------------------------------------ */

test('an empty tender is rejected instead of being read as zero', () => {
  assert.match(String(validateCashTender('', 1000)), /enter the cash received/i);
  assert.match(String(validateCashTender('   ', 1000)), /enter the cash received/i);
  assert.match(String(validateCashTender(null, 1000)), /enter the cash received/i);
  assert.match(String(validateCashTender(undefined, 1000)), /enter the cash received/i);
});

test('a tender that is not a number is rejected', () => {
  assert.match(String(validateCashTender('abc', 1000)), /valid number/i);
  assert.match(String(validateCashTender(Infinity, 1000)), /valid number/i);
});

test('a negative tender is rejected', () => {
  assert.match(String(validateCashTender(-1, 1000)), /negative/i);
  assert.match(String(validateCashTender('-0.01', 1000)), /negative/i);
});

test('a tender below the amount due is rejected, including by one paisa', () => {
  assert.match(String(validateCashTender(9.99, 1000)), /less than the total/i);
  assert.match(String(validateCashTender(9.99, 1000)), /Rs\. 9\.99/);
  assert.match(String(validateCashTender(9.99, 1000)), /Rs\. 10\.00/);
});

test('an exact tender is accepted', () => {
  assert.equal(validateCashTender(10, 1000), null);
  assert.equal(validateCashTender('10', 1000), null);
  assert.equal(validateCashTender(10.0, 1000), null);
});

test('an overpayment is accepted', () => {
  assert.equal(validateCashTender(20, 1000), null);
  assert.equal(validateCashTender(10.01, 1000), null);
});

/* ------------------------------------------------------------------ */
/* Deriving the change                                                  */
/* ------------------------------------------------------------------ */

test('the change of an exact payment is exactly zero', () => {
  assert.equal(changePaisa(10, 1000), 0);
  assert.equal(changePaisa('10', 1000), 0);
});

test('the change of an overpayment is exact to the paisa', () => {
  assert.equal(changePaisa(20, 1000), 1000);
  assert.equal(changePaisa(10.01, 1000), 1, 'one paisa of change is one paisa');
  assert.equal(changePaisa(19.99, 1999), 0);
});

test('the change is never negative', () => {
  assert.equal(changePaisa(5, 1000), 0, 'a tender below the total yields no change');
  assert.equal(changePaisa('', 1000), 0);
  assert.equal(changePaisa('abc', 1000), 0);
});

test('the change of a confirmed sale comes from the stored tender and total', () => {
  assert.equal(changeFromSale({ cashReceived: 20, total: 10 }), 1000);
  assert.equal(changeFromSale({ cashReceived: 10, total: 10 }), 0, 'an exact payment has no change to give');
  assert.equal(changeFromSale({ cashReceived: 10.01, total: 10 }), 1);
});

test('a sale that was not paid in cash has no change', () => {
  assert.equal(changeFromSale({ cashReceived: null, total: 10 }), null);
  assert.equal(changeFromSale({ total: 10 }), null);
  assert.equal(changeFromSale(null), null);
});
