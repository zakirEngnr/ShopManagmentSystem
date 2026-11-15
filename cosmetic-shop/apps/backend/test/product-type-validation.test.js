// Backend validation regression tests for product types.
//
// Verifies that the product creation / update schemas continue to reject
// invalid product type values. No database is required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productCreateSchema, productUpdateSchema } from '../src/schemas/product.schema.js';

const VALID_TYPES = ['COSMETIC', 'JEWELRY'];
const INVALID_TYPES = ['', null, undefined, 'cosmetic', 'jewelry', 'Cosmetic', 'Jewelry', 'COSMETIC ', 'JEWELRY ', 'BOOKS', 'ELECTRONICS', '123', 'type'];

function baseProductData(over) {
  return Object.assign(
    {
      sku: 'SKU-' + Math.floor(Math.random() * 1e9),
      name: 'Validation Test Product',
      type: 'COSMETIC',
      costPrice: 100,
      sellPrice: 150,
      categoryId: 1,
    },
    over || {}
  );
}

for (const type of INVALID_TYPES) {
  test(`productCreateSchema rejects type=${JSON.stringify(type)}`, () => {
    assert.throws(
      () => productCreateSchema.parse(baseProductData({ type })),
      (err) => {
        assert.ok(err.errors.some((e) => e.path.includes('type')), `expected type error for ${JSON.stringify(type)}`);
        return true;
      },
      `expected validation error for type=${JSON.stringify(type)}`
    );
  });
}

test('productCreateSchema accepts COSMETIC and JEWELRY', () => {
  for (const type of VALID_TYPES) {
    const result = productCreateSchema.parse(baseProductData({ type }));
    assert.equal(result.type, type);
  }
});

test('productUpdateSchema rejects invalid type values', () => {
  // undefined is valid for optional type on update (means "not provided")
  const updateInvalid = INVALID_TYPES.filter((t) => t !== undefined);
  for (const type of updateInvalid) {
    assert.throws(
      () => productUpdateSchema.parse({ type }),
      (err) => {
        assert.ok(err.errors.some((e) => e.path.includes('type')), `expected type error for ${JSON.stringify(type)}`);
        return true;
      },
      `expected validation error for update type=${JSON.stringify(type)}`
    );
  }
});

test('productUpdateSchema accepts COSMETIC and JEWELRY', () => {
  for (const type of VALID_TYPES) {
    const result = productUpdateSchema.parse({ type });
    assert.equal(result.type, type);
  }
});

test('productUpdateSchema accepts missing type (optional on update)', () => {
  const result = productUpdateSchema.parse({ sku: 'SKU-123', name: 'Updated' });
  assert.ok(!('type' in result), 'type should be absent when not provided on update');
});