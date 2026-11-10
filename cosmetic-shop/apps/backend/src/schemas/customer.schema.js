import { z } from 'zod';

/**
 * Zod schemas for the Khata customer module.
 *
 * Conventions (matching the rest of the project):
 * - strings are trimmed before length checks
 * - optional/nullable fields use `.nullish()` so omitted and null are both
 *   accepted; no country-specific phone format is enforced (the project does
 *   not enforce one elsewhere)
 * - `.strict()` rejects unknown fields
 * - public validation messages are generic (see src/middleware/validate.js)
 */

export const createCustomerSchema = z
  .object({
    name: z.string().trim().min(1, { message: 'Required' }).max(100),
    phone: z.string().trim().max(20).nullish(),
    email: z.string().trim().email({ message: 'Invalid email' }).nullish(),
    address: z.string().trim().max(500).nullish(),
    notes: z.string().trim().max(1000).nullish(),
    type: z.enum(['RETAIL', 'BUSINESS', 'PERSONAL']).default('RETAIL'),
  })
  .strict();

export const updateCustomerSchema = z
  .object({
    name: z.string().trim().min(1, { message: 'Required' }).max(100).optional(),
    phone: z.string().trim().max(20).nullish(),
    email: z.string().trim().email({ message: 'Invalid email' }).nullish(),
    address: z.string().trim().max(500).nullish(),
    notes: z.string().trim().max(1000).nullish(),
    type: z.enum(['RETAIL', 'BUSINESS', 'PERSONAL']).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length >= 1, {
    message: 'At least one field is required',
  });

export const recordPaymentSchema = z
  .object({
    amount: z.number().finite().gt(0).max(1e9),
    description: z.string().trim().max(500).nullish(),
  })
  .strict();

export const recordDebtSchema = z
  .object({
    amount: z.number().finite().gt(0).max(1e9),
    description: z.string().trim().min(1, { message: 'Required' }).max(500),
  })
  .strict();

export const customerListQuerySchema = z
  .object({
    type: z.enum(['RETAIL', 'BUSINESS', 'PERSONAL']).optional(),
  })
  .strict();

export const ledgerQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export default {
  createCustomerSchema,
  updateCustomerSchema,
  recordPaymentSchema,
  recordDebtSchema,
  customerListQuerySchema,
  ledgerQuerySchema,
};
