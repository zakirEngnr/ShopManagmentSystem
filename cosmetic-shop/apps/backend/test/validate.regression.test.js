// Validation / safe-error regression tests (no DB required).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { parse, parseId } from '../src/middleware/validate.js';
import { categoryCreateSchema } from '../src/schemas/category.schema.js';
import { brandCreateSchema } from '../src/schemas/brand.schema.js';

const SECRET = 'SECRET-VALUE-9f8b7a';

function expectSafe(err) {
  assert.equal(err.status, 400);
  const msg = String(err.message);
  assert.ok(msg.startsWith('Validation failed:'), `unexpected message: ${msg}`);
  assert.ok(!msg.includes(SECRET), 'leaked attacker-controlled value');
  assert.ok(!msg.includes('password'), 'leaked property name');
  assert.ok(!msg.includes('SECRET-VALUE'), 'leaked attacker-controlled value');
  return msg;
}

test('invalid enum value does not leak submitted value', async () => {
  try {
    parse(categoryCreateSchema, { name: 'Face', type: SECRET });
    assert.fail('expected validation error');
  } catch (err) {
    expectSafe(err);
  }
});

test('unknown fields do not leak property names', async () => {
  const schema = z.object({ name: z.string() }).strict();
  try {
    parse(schema, { name: 'ok', password: SECRET });
    assert.fail('expected validation error');
  } catch (err) {
    expectSafe(err);
  }
});

test('malformed ids are rejected safely', async () => {
  for (const params of [{ id: '0' }, { id: '-1' }, { id: 'abc' }, { id: `${SECRET}` }, {}]) {
    try {
      parseId(params);
      assert.fail(`expected 400 for ${JSON.stringify(params).slice(0, 40)}`);
    } catch (err) {
      assert.equal(err.status, 400);
      assert.ok(!String(err.message).includes(SECRET));
    }
  }
  assert.equal(parseId({ id: '12' }), 12);
});

test('ordinary validation failures stay generic', async () => {
  try {
    parse(brandCreateSchema, { name: '   ' });
    assert.fail('expected validation error');
  } catch (err) {
    assert.equal(err.status, 400);
    assert.ok(String(err.message).startsWith('Validation failed:'));
  }
  try {
    parse(brandCreateSchema, {});
    assert.fail('expected validation error');
  } catch (err) {
    assert.equal(err.status, 400);
  }
});