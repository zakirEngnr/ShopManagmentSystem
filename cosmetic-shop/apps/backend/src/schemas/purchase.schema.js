import { z } from 'zod';

const purchaseItemSchema = z
  .object({
    productId: z.number().int().positive().safe(),
    quantity: z.number().int().positive().max(1000000),
    unitCost: z.number().finite().gt(0).max(1e9),
  })
  .strict();

export const createPurchaseSchema = z
  .object({
    supplierId: z.number().int().positive().safe(),
    items: z.array(purchaseItemSchema).min(1),
  })
  .strict()
  .refine((data) => {
    const seen = new Set();
    for (const item of data.items) {
      if (seen.has(item.productId)) return false;
      seen.add(item.productId);
    }
    return true;
  }, {
    message: 'Duplicate product IDs are not allowed',
    path: ['items'],
  });

export const purchaseListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    supplierId: z.coerce.number().int().positive().optional(),
    from: z.string().trim().max(64).optional(),
    to: z.string().trim().max(64).optional(),
  })
  .strict()
  .refine((data) => {
    if (!data.from && !data.to) return true;
    const values = [data.from, data.to].filter(Boolean);
    return values.every((value) => !Number.isNaN(Date.parse(value)));
  }, {
    message: 'Invalid date',
    path: ['from'],
  });

export default {
  createPurchaseSchema,
  purchaseListQuerySchema,
};
