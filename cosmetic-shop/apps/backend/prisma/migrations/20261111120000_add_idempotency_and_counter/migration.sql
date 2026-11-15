-- Add idempotency keys to money-creating records so duplicate retries can be
-- detected at the database level, and a Counter table for safe invoice number
-- generation. All changes are additive: existing rows remain valid because the
-- idempotency keys are nullable.

-- Sale.idempotencyKey
ALTER TABLE "Sale" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Sale_idempotencyKey_key" ON "Sale"("idempotencyKey");

-- Purchase.idempotencyKey
ALTER TABLE "Purchase" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Purchase_idempotencyKey_key" ON "Purchase"("idempotencyKey");

-- KhataTransaction.idempotencyKey
ALTER TABLE "KhataTransaction" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "KhataTransaction_idempotencyKey_key" ON "KhataTransaction"("idempotencyKey");

-- SupplierPayment.idempotencyKey
ALTER TABLE "SupplierPayment" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "SupplierPayment_idempotencyKey_key" ON "SupplierPayment"("idempotencyKey");

-- Counter: atomically allocated invoice sequences per key (e.g. invoice-<year>)
CREATE TABLE "Counter" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" INTEGER NOT NULL
);
