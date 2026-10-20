-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Product" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "costPrice" REAL NOT NULL,
    "sellPrice" REAL NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "lowStockAt" INTEGER NOT NULL DEFAULT 5,
    "expiryDate" DATETIME,
    "imageUrl" TEXT,
    "categoryId" INTEGER NOT NULL,
    "brandId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Product_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Product" ("barcode", "brandId", "categoryId", "costPrice", "createdAt", "expiryDate", "id", "imageUrl", "lowStockAt", "name", "sellPrice", "sku", "stock", "type", "updatedAt") SELECT "barcode", "brandId", "categoryId", "costPrice", "createdAt", "expiryDate", "id", "imageUrl", "lowStockAt", "name", "sellPrice", "sku", "stock", "type", "updatedAt" FROM "Product";
DROP TABLE "Product";
ALTER TABLE "new_Product" RENAME TO "Product";
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");
CREATE UNIQUE INDEX "Product_barcode_key" ON "Product"("barcode");
CREATE INDEX "Product_name_idx" ON "Product"("name");
CREATE INDEX "Product_barcode_idx" ON "Product"("barcode");
CREATE INDEX "Product_type_idx" ON "Product"("type");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
