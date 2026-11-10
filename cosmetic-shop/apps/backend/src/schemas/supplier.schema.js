import { z } from 'zod';

export const createSupplierSchema = z
  .object({
    name: z.string().trim().min(1, { message: 'Required' }).max(200),
    phone: z.string().trim().max(30).nullish(),
    email: z.string().trim().email({ message: 'Invalid email' }).max(255).nullish(),
    address: z.string().trim().max(500).nullish(),
    notes: z.string().trim().max(1000).nullish(),
  })
  .strict();

export const recordSupplierPaymentSchema = z
  .object({
    amount: z.number().finite().gt(0).max(1e9),
    description: z.string().trim().max(500).nullish(),
  })
  .strict();

export const supplierListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(100).optional(),
  })
  .strict();

export default {
  createSupplierSchema,
  recordSupplierPaymentSchema,
  supplierListQuerySchema,
};
