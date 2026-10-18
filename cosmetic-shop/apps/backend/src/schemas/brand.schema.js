import { z } from 'zod';

export const brandCreateSchema = z
  .object({
    name: z.string().trim().min(1, { message: 'Required' }).max(100),
  })
  .strict();

export const brandUpdateSchema = z
  .object({
    name: z.string().trim().min(1, { message: 'Required' }).max(100).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length >= 1, {
    message: 'At least one field is required',
  });

export default { brandCreateSchema, brandUpdateSchema };

