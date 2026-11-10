import { z } from 'zod';
import { EXPENSE_CATEGORIES } from '../config/constants.js';

const isoDateString = z
  .string()
  .trim()
  .refine((value) => value.length > 0 && !Number.isNaN(Date.parse(value)), {
    message: 'Invalid date',
  });

export const createExpenseSchema = z
  .object({
    date: isoDateString.optional(),
    category: z.enum(EXPENSE_CATEGORIES, { message: 'Invalid category' }).optional(),
    expenseName: z.string().trim().optional(),
    description: z
      .string()
      .trim()
      .min(1, { message: 'Description is required' })
      .max(255, { message: 'Description is too long' }),
    amount: z.number().finite().gt(0).lte(1_000_000_000, {
      message: 'amount must be greater than 0 and at most 1000000000',
    }),
  })
  .strict();

export const updateExpenseSchema = z
  .object({
    date: isoDateString.optional(),
    category: z.enum(EXPENSE_CATEGORIES, { message: 'Invalid category' }).optional(),
    expenseName: z.string().trim().optional(),
    description: z
      .string()
      .trim()
      .min(1, { message: 'Description is required' })
      .max(255, { message: 'Description is too long' })
      .optional(),
    amount: z
      .number()
      .finite()
      .gt(0)
      .lte(1_000_000_000, {
        message: 'amount must be greater than 0 and at most 1000000000',
      })
      .optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length >= 1, {
    message: 'At least one field is required',
  });

export default { createExpenseSchema, updateExpenseSchema };
