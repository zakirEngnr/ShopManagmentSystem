-- Correct three foreign-key actions so the migration chain matches
-- prisma/schema.prisma exactly.
--
--   1. PaymentAllocation_paymentId_fkey      : ON UPDATE NO ACTION  -> ON UPDATE CASCADE
--   2. PaymentAllocation_saleId_fkey         : ON UPDATE NO ACTION  -> ON UPDATE CASCADE
--   3. SupplierPaymentAllocation_purchaseId_fkey : ON DELETE CASCADE -> ON DELETE RESTRICT
--
-- SQLite cannot ALTER a foreign key action in place, so both tables are rebuilt
-- (the standard Prisma "RedefineTables" pattern): a replacement table is
-- created, every row is copied into it, the old table is dropped and the
-- replacement is renamed into place. All rows of both tables are copied, so no
-- data is lost.
--
-- This migration is safe to run more than once: it recreates the same
-- structure and copies every row again, on a database that still has the old
-- foreign-key actions and on a database that already has the corrected ones.
--
-- Both rebuilt tables have no child tables that reference them, so no row can
-- be removed by a cascading delete while the foreign-key enforcement is
-- temporarily switched off.

-- RedefineTables: PaymentAllocation
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PaymentAllocation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "paymentId" INTEGER NOT NULL,
    "saleId" INTEGER NOT NULL,
    "amount" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "KhataTransaction" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaymentAllocation_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PaymentAllocation" ("amount", "createdAt", "id", "paymentId", "saleId") SELECT "amount", "createdAt", "id", "paymentId", "saleId" FROM "PaymentAllocation";
DROP TABLE "PaymentAllocation";
ALTER TABLE "new_PaymentAllocation" RENAME TO "PaymentAllocation";
CREATE INDEX "PaymentAllocation_paymentId_idx" ON "PaymentAllocation"("paymentId");
CREATE INDEX "PaymentAllocation_saleId_idx" ON "PaymentAllocation"("saleId");
CREATE UNIQUE INDEX "PaymentAllocation_paymentId_saleId_key" ON "PaymentAllocation"("paymentId", "saleId");

-- RedefineTables: SupplierPaymentAllocation
CREATE TABLE "new_SupplierPaymentAllocation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "supplierPaymentId" INTEGER NOT NULL,
    "purchaseId" INTEGER NOT NULL,
    "amount" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupplierPaymentAllocation_supplierPaymentId_fkey" FOREIGN KEY ("supplierPaymentId") REFERENCES "SupplierPayment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SupplierPaymentAllocation_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_SupplierPaymentAllocation" ("amount", "createdAt", "id", "purchaseId", "supplierPaymentId") SELECT "amount", "createdAt", "id", "purchaseId", "supplierPaymentId" FROM "SupplierPaymentAllocation";
DROP TABLE "SupplierPaymentAllocation";
ALTER TABLE "new_SupplierPaymentAllocation" RENAME TO "SupplierPaymentAllocation";
CREATE INDEX "SupplierPaymentAllocation_supplierPaymentId_idx" ON "SupplierPaymentAllocation"("supplierPaymentId");
CREATE INDEX "SupplierPaymentAllocation_purchaseId_idx" ON "SupplierPaymentAllocation"("purchaseId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
