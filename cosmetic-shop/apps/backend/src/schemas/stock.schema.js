import { z } from 'zod';
import { STOCK_REASONS } from '../config/constants.js';

export const createStockAdjustSchema = z.object({
  productId: z.number().refine((n) => Number.isInteger(n) && Number.isSafeInteger(n) && n > 0, {
    message: 'productId must be a safe positive integer',
  }),
  delta: z.number().refine((n) => Number.isInteger(n) && Number.isSafeInteger(n) && n !== 0, {
    message: 'delta must be a non-zero safe integer',
  }),
  reason: z.enum(Object.values(STOCK_REASONS), { message: 'Invalid reason' }),
  unitCost: z.number().refine((n) => Number.isFinite(n) && n >= 0 && Math.abs(n) <= Number.MAX_SAFE_INTEGER, {
    message: 'unitCost must be a finite non-negative safe number',
  }).optional(),
}).strict();
