-- Add Supplier, Purchase, PurchaseItem, SupplierPayment, and SupplierPaymentAllocation tables.
-- These tables are referenced by the current Prisma schema but were missing from the
-- migration chain. Migration 8 (add_idempotency_and_counter) adds idempotencyKey columns
-- to Purchase and SupplierPayment, so those columns are NOT included here.

-- CreateTable Supplier
CREATE TABLE "Supplier" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "balance" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex Supplier_name_idx
CREATE INDEX "Supplier_name_idx" ON "Supplier"("name");

-- CreateTable Purchase
CREATE TABLE "Purchase" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "supplierId" INTEGER NOT NULL,
    "totalAmount" REAL NOT NULL,
    "paidAmount" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'UNPAID',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Purchase_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex Purchase_supplierId_idx
CREATE INDEX "Purchase_supplierId_idx" ON "Purchase"("supplierId");

-- CreateIndex Purchase_createdAt_idx
CREATE INDEX "Purchase_createdAt_idx" ON "Purchase"("createdAt");

-- CreateTable PurchaseItem
CREATE TABLE "PurchaseItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "purchaseId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" REAL NOT NULL,
    "total" REAL NOT NULL,
    CONSTRAINT "PurchaseItem_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PurchaseItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex PurchaseItem_purchaseId_idx
CREATE INDEX "PurchaseItem_purchaseId_idx" ON "PurchaseItem"("purchaseId");

-- CreateIndex PurchaseItem_productId_idx
CREATE INDEX "PurchaseItem_productId_idx" ON "PurchaseItem"("productId");

-- CreateTable SupplierPayment
CREATE TABLE "SupplierPayment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "supplierId" INTEGER NOT NULL,
    "amount" REAL NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupplierPayment_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex SupplierPayment_supplierId_idx
CREATE INDEX "SupplierPayment_supplierId_idx" ON "SupplierPayment"("supplierId");

-- CreateIndex SupplierPayment_createdAt_idx
CREATE INDEX "SupplierPayment_createdAt_idx" ON "SupplierPayment"("createdAt");

-- CreateTable SupplierPaymentAllocation
CREATE TABLE "SupplierPaymentAllocation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "supplierPaymentId" INTEGER NOT NULL,
    "purchaseId" INTEGER NOT NULL,
    "amount" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupplierPaymentAllocation_supplierPaymentId_fkey" FOREIGN KEY ("supplierPaymentId") REFERENCES "SupplierPayment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SupplierPaymentAllocation_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex SupplierPaymentAllocation_supplierPaymentId_idx
CREATE INDEX "SupplierPaymentAllocation_supplierPaymentId_idx" ON "SupplierPaymentAllocation"("supplierPaymentId");

-- CreateIndex SupplierPaymentAllocation_purchaseId_idx
CREATE INDEX "SupplierPaymentAllocation_purchaseId_idx" ON "SupplierPaymentAllocation"("purchaseId");
