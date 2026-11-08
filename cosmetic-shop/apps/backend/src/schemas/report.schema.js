import { z } from 'zod';

/**
 * Strict ISO calendar date (YYYY-MM-DD).
 * Rejects non-calendar dates such as 2026-02-30 by round-tripping the
 * parsed UTC components, since Date.parse alone rolls them over.
 */
const strictDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Invalid date' })
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const check = new Date(Date.UTC(year, month - 1, day));
    return (
      check.getUTCFullYear() === year &&
      check.getUTCMonth() === month - 1 &&
      check.getUTCDate() === day
    );
  }, { message: 'Invalid date' });

/** Optional strict date for the daily report (defaults to today in the service). */
export const dailyDateSchema = z.object({
  date: strictDate.optional(),
});

/** Required inclusive date range; from must not be after to. */
export const dateRangeSchema = z
  .object({
    from: strictDate,
    to: strictDate,
  })
  .refine((data) => data.from <= data.to, {
    message: 'from must be before or equal to to',
    path: ['from'],
  });

/** Top-products query: inclusive range plus optional page size. */
export const topProductsSchema = z.object({
  from: strictDate,
  to: strictDate,
  limit: z.coerce.number().int().positive().max(50).default(5),
});

/** Expiring-soon query: optional look-ahead window in days. */
export const daysQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(365).default(30),
});

export default {
  dailyDateSchema,
  dateRangeSchema,
  topProductsSchema,
  daysQuerySchema,
};
