import { z } from 'zod';
import { PRODUCT_TYPES } from '../config/constants.js';

const PRODUCT_TYPE_VALUES = Object.values(PRODUCT_TYPES);

const idField = z.number().int().positive().refine((n) => Number.isSafeInteger(n), {
  message: 'Invalid id',
});

const skuField = z
  .string()
  .trim()
  .min(1, { message: 'Required' })
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, { message: 'Invalid sku' });

const barcodeField = z
  .string()
  .trim()
  .min(1, { message: 'Required' })
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, { message: 'Invalid barcode' });

const moneyField = z.number().finite().min(0).max(1000000000);
const lowStockField = z.number().int().min(0).max(1000000).refine((n) => Number.isSafeInteger(n), {
  message: 'Invalid value',
});
const stockField = z.number().int().min(0).max(1000000).refine((n) => Number.isSafeInteger(n), {
  message: 'Invalid value',
});
const expiryField = z
  .string()
  .trim()
  .max(64)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'Invalid date' });

export const productCreateSchema = z
  .object({
    sku: skuField,
    barcode: barcodeField.nullish(),
    name: z.string().trim().min(1, { message: 'Required' }).max(200),
    type: z.enum(PRODUCT_TYPE_VALUES),
    costPrice: moneyField,
    sellPrice: moneyField,
    stock: stockField.optional(),
    lowStockAt: lowStockField.optional(),
    expiryDate: expiryField.optional(),
    categoryId: idField,
    brandId: idField.nullish(),
  })
  .strict();

// Product updates may NOT modify stock: stock changes go exclusively through
// the stock module (empty authorized placeholder, no source establishing
// product-CRUD stock writes). imageUrl is also excluded — Phase C owns image
// behavior. id/category relation integrity handled in service.
export const productUpdateSchema = z
  .object({
    sku: skuField.optional(),
    barcode: barcodeField.nullish(),
    name: z.string().trim().min(1, { message: 'Required' }).max(200).optional(),
    type: z.enum(PRODUCT_TYPE_VALUES).optional(),
    costPrice: moneyField.optional(),
    sellPrice: moneyField.optional(),
    lowStockAt: lowStockField.optional(),
    expiryDate: expiryField.nullish(),
    categoryId: idField.optional(),
    brandId: idField.nullish(),
  })
  .strict()
  .refine((data) => Object.keys(data).length >= 1, {
    message: 'At least one field is required',
  });

const SORT_FIELDS = ['name', 'sku', 'costPrice', 'sellPrice', 'stock', 'createdAt'];

export const productQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sortBy: z.enum(SORT_FIELDS).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
    search: z.string().trim().max(100).optional(),
    categoryId: z.coerce.number().int().positive().optional(),
    brandId: z.coerce.number().int().positive().optional(),
    type: z.enum(PRODUCT_TYPE_VALUES).optional(),
  })
  .strict();

export default { productCreateSchema, productUpdateSchema, productQuerySchema };

