import { z } from 'zod';

/**
 * Zod schema for creating a sale (POS transaction).
 * Validation rules:
 * - Exactly one of productId or manualName per item
 * - unitCost is accepted in payload but IGNORED by the service
 *   (client-supplied unitCost must never be trusted)
 */
export const createSaleSchema = z.object({
  paymentMethod: z.enum(['CASH', 'CARD', 'MOBILE']),

  discount: z.number().min(0).default(0),

  items: z
    .array(
      z.object({
        productId: z.number().int().positive().optional(),
        manualName: z.string().max(100).optional(),
        quantity: z.number().int().positive(),
        unitPrice: z.number().min(0),
        unitCost: z.number().optional(),
      })
    )
    .min(1),
}).refine(
  (data) => {
    const items = data.items;
    // Exactly one of productId or manualName must be provided per item
    for (const item of items) {
      const hasProductId = item.productId !== undefined && item.productId !== null;
      const hasManualName = item.manualName !== undefined && item.manualName !== null;
      if (hasProductId === hasManualName) return false; // both true or both false
    }
    return true;
  },
  'Exactly one of productId or manualName must be provided'
);