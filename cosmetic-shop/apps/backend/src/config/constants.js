export const PRODUCT_TYPES = Object.freeze({
  COSMETIC: 'COSMETIC',
  JEWELRY: 'JEWELRY',
});

export const PAYMENT_METHODS = Object.freeze({
  CASH: 'CASH',
  CARD: 'CARD',
  MOBILE: 'MOBILE',
});

export const STOCK_REASONS = Object.freeze({
  PURCHASE: 'PURCHASE',
  DAMAGE: 'DAMAGE',
  LOSS: 'LOSS',
  RETURN: 'RETURN',
  CORRECTION: 'CORRECTION',
  OTHER: 'OTHER',
});

export const EXPENSE_CATEGORIES = Object.freeze([
  'RENT',
  'SALARIES',
  'UTILITIES',
  'PACKAGING',
  'TRANSPORT',
  'MARKETING',
  'OTHER',
]);

export const INVOICE_PREFIX = 'INV';

export default {
  PRODUCT_TYPES,
  PAYMENT_METHODS,
  STOCK_REASONS,
  EXPENSE_CATEGORIES,
  INVOICE_PREFIX,
};
