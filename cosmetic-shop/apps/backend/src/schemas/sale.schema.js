import { z } from 'zod';
import { moneyAmount, withTwoDecimals } from '../utils/money.js';

/**
 * Zod schema for creating a sale (POS transaction).
 * Validation rules:
 * - Exactly one of productId or manualName per item
 * - unitCost is accepted in payload but IGNORED by the service
 *   (client-supplied unitCost must never be trusted)
 * - All monetary amounts (discount, unitPrice, cashReceived) allow at most 2 decimal
 *   places via the moneyAmount() Zod helper.
 * - cashReceived is the cash the customer handed over. It is only meaningful
 *   for CASH payments, so the schema accepts three distinct shapes and the
 *   SERVICE decides which of them is allowed for a given payment method:
 *     * missing  (the key is absent)  -> undefined
 *     * null     (the key is present)  -> null
 *     * a number (finite, at most 2 decimals)
 *   A number that is NaN, Infinity, a string or has more than two decimal
 *   places is rejected here.
 */
export const createSaleSchema = z.object({
  paymentMethod: z.enum(['CASH', 'CARD', 'JAZZCASH', 'MOBILE', 'KHATA']),

  // Associates the sale with a credit customer. Required when paying by KHATA;
  // accepted (but does not create a ledger entry) for other payment methods.
  customerId: z.number().int().positive().optional(),

  discount: withTwoDecimals(moneyAmount().min(0)).default(0),

  // The cash tender. `undefined` (omitted), `null` (explicitly no tender) and
  // a number are three different things and stay distinguishable here.
  cashReceived: z
    .union([z.literal(null), withTwoDecimals(moneyAmount())])
    .optional(),

  items: z
    .array(
      z.object({
        productId: z.number().int().positive().optional(),
        manualName: z.string().max(100).optional(),
        quantity: z.number().int().positive(),
        unitPrice: withTwoDecimals(moneyAmount().min(0)),
        unitCost: z.number().optional(),
      })
    )
    .min(1),
})
.refine(
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
)
.refine(
  (data) => {
    if (data.paymentMethod === 'KHATA') {
      return data.customerId !== undefined && data.customerId !== null && data.customerId > 0;
    }
    return true;
  },
  'customerId is required for KHATA sales'
);
