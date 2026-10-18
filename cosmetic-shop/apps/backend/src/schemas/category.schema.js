import { z } from 'zod';
import { PRODUCT_TYPES } from '../config/constants.js';

const PRODUCT_TYPE_VALUES = Object.values(PRODUCT_TYPES);

export const categoryCreateSchema = z
  .object({
    name: z.string().trim().min(1, { message: 'Required' }).max(100),
    type: z.enum(PRODUCT_TYPE_VALUES),
  })
  .strict();

export const categoryUpdateSchema = z
  .object({
    name: z.string().trim().min(1, { message: 'Required' }).max(100).optional(),
    type: z.enum(PRODUCT_TYPE_VALUES).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length >= 1, {
    message: 'At least one field is required',
  });

export default { categoryCreateSchema, categoryUpdateSchema };

