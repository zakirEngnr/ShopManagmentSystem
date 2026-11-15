// Unit tests for the KHATA ledger running balance.
//
// The ledger API returns the rows NEWEST FIRST (backend order:
// `ORDER BY createdAt DESC, id DESC`) and `customer.balance` is the
// authoritative CURRENT balance, i.e. the balance after every transaction.
// The historical balances are derived by walking the rows backwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeRunningBalances,
  computePageAnchor,
  getTransactionBalanceEffect,
  netBalanceEffect,
} from '../src/utils/ledger.js';

/** Build a ledger page in backend order: newest first. */
function page(...rowsOldestFirst) {
  return rowsOldestFirst
    .map((row, index) => ({
      id: index + 1,
      createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      ...row,
    }))
    .reverse();
}

const SALE = (amount, id) => ({ id, type: 'SALE', amount });
const PAYMENT = (amount, id) => ({ id, type: 'PAYMENT', amount });
const DEBT = (amount, id) => ({ id, type: 'DEBT', amount });

test('transaction effect: PAYMENT reduces the balance, every other type increases it', () => {
  assert.equal(getTransactionBalanceEffect({ type: 'SALE', amount: 100 }), 100);
  assert.equal(getTransactionBalanceEffect({ type: 'DEBT', amount: 50 }), 50);
  assert.equal(getTransactionBalanceEffect({ type: 'ADJUSTMENT', amount: 25 }), 25);
  assert.equal(getTransactionBalanceEffect({ type: 'PAYMENT', amount: 30 }), -30);
  assert.equal(getTransactionBalanceEffect({ type: 'SALE', amount: 0 }), 0);
});

test('case 1: a single sale', () => {
  const transactions = page(SALE(100, 1));
  const rows = computeRunningBalances(transactions, 100);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].before, 0);
  assert.equal(rows[0].after, 100);
  assert.equal(rows[0].after, 100, 'the newest row must show the customer balance');
});

test('case 2: multiple sales', () => {
  // oldest -> newest: SALE 100, SALE 50 ; customer.balance = 150
  const transactions = page(SALE(100, 1), SALE(50, 2));
  const rows = computeRunningBalances(transactions, 150);

  assert.equal(rows.length, 2);
  // display order is newest first
  assert.equal(rows[0].id, 2);
  assert.equal(rows[0].before, 100);
  assert.equal(rows[0].after, 150);
  assert.equal(rows[1].id, 1);
  assert.equal(rows[1].before, 0);
  assert.equal(rows[1].after, 100);
  assert.equal(rows[0].after, 150, 'the newest row must show the customer balance');
});

test('case 3: a sale followed by a payment', () => {
  // oldest -> newest: SALE 100, PAYMENT 30 ; customer.balance = 70
  const transactions = page(SALE(100, 1), PAYMENT(30, 2));
  const rows = computeRunningBalances(transactions, 70);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 2);
  assert.equal(rows[0].before, 100);
  assert.equal(rows[0].after, 70);
  assert.equal(rows[1].id, 1);
  assert.equal(rows[1].before, 0);
  assert.equal(rows[1].after, 100);
  assert.equal(rows[0].after, 70, 'the newest row must show the customer balance');
});

test('case 4: a payment followed by another sale', () => {
  // oldest -> newest: SALE 100, PAYMENT 30, SALE 50 ; customer.balance = 120
  const transactions = page(SALE(100, 1), PAYMENT(30, 2), SALE(50, 3));
  const rows = computeRunningBalances(transactions, 120);

  assert.equal(rows.length, 3);
  assert.equal(rows[0].id, 3);
  assert.equal(rows[0].before, 70);
  assert.equal(rows[0].after, 120);
  assert.equal(rows[1].id, 2);
  assert.equal(rows[1].before, 100);
  assert.equal(rows[1].after, 70);
  assert.equal(rows[2].id, 1);
  assert.equal(rows[2].before, 0);
  assert.equal(rows[2].after, 100);
  assert.equal(rows[0].after, 120, 'the newest row must show the customer balance');
});

test('case 5: multiple transactions that end at a zero balance', () => {
  // oldest -> newest: SALE 100, PAYMENT 60, SALE 40, PAYMENT 40 ; balance = 40
  const transactions = page(SALE(100, 1), PAYMENT(60, 2), SALE(40, 3), PAYMENT(40, 4));
  const rows = computeRunningBalances(transactions, 40);

  assert.equal(rows.length, 4);
  assert.equal(rows[0].id, 4);
  assert.equal(rows[0].before, 80);
  assert.equal(rows[0].after, 40);
  assert.equal(rows[1].id, 3);
  assert.equal(rows[1].before, 40);
  assert.equal(rows[1].after, 80);
  assert.equal(rows[2].id, 2);
  assert.equal(rows[2].before, 100);
  assert.equal(rows[2].after, 40);
  assert.equal(rows[3].id, 1);
  assert.equal(rows[3].before, 0);
  assert.equal(rows[3].after, 100);
  assert.equal(rows[0].after, 40, 'the newest row must show the customer balance');
});

test('case 5b: a debt entry also increases the balance', () => {
  // oldest -> newest: SALE 100, DEBT 20, PAYMENT 120 ; balance = 0
  const transactions = page(SALE(100, 1), DEBT(20, 2), PAYMENT(120, 3));
  const rows = computeRunningBalances(transactions, 0);

  assert.equal(rows[0].id, 3);
  assert.equal(rows[0].before, 120);
  assert.equal(rows[0].after, 0);
  assert.equal(rows[1].id, 2);
  assert.equal(rows[1].after, 120);
  assert.equal(rows[2].id, 1);
  assert.equal(rows[2].before, 0);
  assert.equal(rows[2].after, 100);
});

test('case 6: pagination - every page is anchored on the customer balance', () => {
  // oldest -> newest: SALE 100, PAYMENT 40, SALE 60, PAYMENT 20, SALE 30
  // customer.balance = 100 - 40 + 60 - 20 + 30 = 130
  const all = page(SALE(100, 1), PAYMENT(40, 2), SALE(60, 3), PAYMENT(20, 4), SALE(30, 5));
  const pageSize = 2;

  const page1 = all.slice(0, pageSize);
  const page2 = all.slice(pageSize, pageSize * 2);
  const page3 = all.slice(pageSize * 2);

  // ---- page 1 (the newest page) ----
  const anchor1 = computePageAnchor(130, 0);
  const rows1 = computeRunningBalances(page1, anchor1);
  assert.equal(rows1[0].id, 5);
  assert.equal(rows1[0].after, 130, 'the newest row must show the customer balance');
  assert.equal(rows1[0].before, 100);
  assert.equal(rows1[1].id, 4);
  assert.equal(rows1[1].after, 100);
  assert.equal(rows1[1].before, 120);

  // ---- page 2 needs the effect of the transactions that are newer than it ----
  const newerEffect = netBalanceEffect(page1);
  assert.equal(newerEffect, 10, '30 - 20 = the net effect of page 1');
  const anchor2 = computePageAnchor(130, newerEffect);
  assert.equal(anchor2, 120);

  const rows2 = computeRunningBalances(page2, anchor2);
  assert.equal(rows2[0].id, 3);
  assert.equal(rows2[0].after, 120, 'the balance after SALE 60');
  assert.equal(rows2[0].before, 60);
  assert.equal(rows2[1].id, 2);
  assert.equal(rows2[1].after, 60, 'the balance after PAYMENT 40');
  assert.equal(rows2[1].before, 100);

  // ---- page 3 ----
  const newerEffect3 = netBalanceEffect(page1) + netBalanceEffect(page2);
  assert.equal(newerEffect3, 10 + 20);
  const anchor3 = computePageAnchor(130, newerEffect3);
  const rows3 = computeRunningBalances(page3, anchor3);
  assert.equal(rows3[0].id, 1);
  assert.equal(rows3[0].after, 100, 'the balance after the oldest transaction');
  assert.equal(rows3[0].before, 0);

  // every page agrees with the ledger that was computed in one go
  const whole = computeRunningBalances(all, 130);
  assert.equal(whole.length, 5);
  assert.equal(whole[0].after, 130);
  assert.equal(whole[4].after, 100);
  assert.equal(whole[4].before, 0);
});

test('the running balance never mutates the transactions it is given', () => {
  const transactions = page(SALE(100, 1), PAYMENT(30, 2));
  const snapshot = JSON.stringify(transactions);
  const rows = computeRunningBalances(transactions, 70);
  assert.equal(JSON.stringify(transactions), snapshot, 'the input must not be modified');
  assert.equal(transactions[0].before, undefined, 'the input rows must not gain a balance');
  assert.equal(transactions[0].after, undefined, 'the input rows must not gain a balance');
  assert.equal(rows[0].after, 70);
  assert.notEqual(rows[0], transactions[0], 'the returned rows must be new objects');
});

test('an empty or missing transaction list yields no rows', () => {
  assert.deepEqual(computeRunningBalances([], 100), []);
  assert.deepEqual(computeRunningBalances(undefined, 100), []);
  assert.deepEqual(computeRunningBalances(null, 100), []);
});

test('a missing anchor falls back to zero instead of NaN', () => {
  const rows = computeRunningBalances(page(SALE(100, 1)), undefined);
  assert.equal(Number.isFinite(rows[0].before), true, 'the balance must be a finite number');
  assert.equal(Number.isFinite(rows[0].after), true, 'the balance must be a finite number');
  assert.equal(rows[0].after, 0, 'the anchor defaults to zero');
});
