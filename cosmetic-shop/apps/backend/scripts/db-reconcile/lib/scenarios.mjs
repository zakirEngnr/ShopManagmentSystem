// Disposable scenario fixtures (A-G) used by the test suite.
//
// Every scenario is built from the real migration chain plus deterministic
// "legacy damage" that reproduces a plausible historical state. Nothing here
// ever touches a database outside the OS temp directory.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, openWritable, splitSql } from './sqlite.mjs';

export const MIGRATIONS = [
  '20261018125524_init',
  '20261020122712_add_user_token_version',
  '20261020124202_brand_fk_restrict',
  '20261109144319_add_khata_tables',
  '20261110074739_add_customer_type',
  '20261110083036_add_recognized_amount_and_payment_allocation',
  '20261110120000_add_expense_name_to_expense',
  '20261110150000_add_purchase_supplier_tables',
  '20261111120000_add_idempotency_and_counter',
  '20261112184500_fix_fk_actions',
  '20261114090000_add_cash_received_to_sale',
  '20261115100000_add_expense_auditability',
];

export function applyMigrations(migrationsDir, dbPath, upTo = MIGRATIONS.length) {
  fs.rmSync(dbPath, { force: true });
  const db = openWritable(dbPath);
  try {
    for (const name of MIGRATIONS.slice(0, upTo)) {
      const sql = fs.readFileSync(path.join(migrationsDir, name, 'migration.sql'), 'utf8');
      for (const statement of splitSql(sql)) db.exec(statement);
    }
  } finally {
    db.close();
  }
}

const NOW = '2026-01-15 09:00:00';
// bcrypt hash of 'ReconcileTest123!' so the application level harness can log in.
const ADMIN_HASH = '$2a$12$/X09XKPZH4TistphEaHQ/.rtqmTi0VJizd0bhdDpvRvP2EujYPMMW';

export function seedData(db, { withSuppliers = true, withIdempotency = true } = {}) {
  const exec = (sql) => db.exec(sql);
  exec(`INSERT INTO "User" ("id","name","email","password","role","isActive","failedAttempts","tokenVersion","createdAt","updatedAt")
        VALUES (1,'Admin','admin@shop.local','${ADMIN_HASH}','ADMIN',1,0,0,'${NOW}','${NOW}')`);
  exec(`INSERT INTO "Setting" ("key","value") VALUES ('currency','PKR'),('shopName','Demo Cosmetics')`);
  if (withIdempotency) exec(`INSERT INTO "Counter" ("key","value") VALUES ('invoice-2026',42)`);
  exec(`INSERT INTO "Category" ("id","name","type","createdAt") VALUES (1,'Skincare','SKIN','${NOW}')`);
  exec(`INSERT INTO "Brand" ("id","name","createdAt") VALUES (1,'GlowLab','${NOW}')`);
  exec(`INSERT INTO "Product" ("id","sku","barcode","name","type","costPrice","sellPrice","stock","lowStockAt","categoryId","brandId","createdAt","updatedAt")
        VALUES (1,'SKU-001','111111','Face Wash','SKIN',100,250,40,5,1,1,'${NOW}','${NOW}'),
               (2,'SKU-002','222222','Body Lotion','SKIN',200,450,12,5,1,1,'${NOW}','${NOW}')`);
  exec(`INSERT INTO "Customer" ("id","name","phone","email","balance","type","createdAt","updatedAt")
        VALUES (1,'Ayesha Khan','0300-1112223','ayesha@example.com',1500,'RETAIL','${NOW}','${NOW}'),
               (2,'Bilal Ahmed','0300-3334445',NULL,0,'WHOLESALE','${NOW}','${NOW}')`);
  exec(`INSERT INTO "Sale" ("id","invoiceNo","subtotal","discount","total","recognizedAmount","paymentMethod","customerId","createdAt")
        VALUES (1,'INV-0001',1000,100,900,900,'CASH',NULL,'${NOW}'),
               (2,'INV-0002',2000,0,2000,0,'KHATA',1,'${NOW}')`);
  exec(`INSERT INTO "SaleItem" ("id","saleId","productId","manualName","quantity","unitPrice","unitCost","total")
        VALUES (1,1,1,NULL,2,500,100,1000),(2,2,2,NULL,1,2000,200,2000)`);
  exec(`INSERT INTO "KhataTransaction" ("id","customerId","type","amount","description","saleId","createdAt")
        VALUES (1,1,'SALE',2000,'Invoice INV-0002',2,'${NOW}'),
               (2,1,'PAYMENT',500,'Cash payment',NULL,'${NOW}'),
               (3,2,'SALE',300,'Manual sale',NULL,'${NOW}')`);
  exec(`INSERT INTO "PaymentAllocation" ("id","paymentId","saleId","amount","createdAt") VALUES (1,2,2,500,'${NOW}')`);
  exec(`INSERT INTO "StockAdjust" ("id","productId","delta","reason","unitCost","createdAt")
        VALUES (1,1,-2,'Damaged goods',100,'${NOW}')`);
  exec(`INSERT INTO "Expense" ("id","date","category","expenseName","description","amount","createdAt")
        VALUES (1,'${NOW}','RENT','Shop rent','January rent',25000,'${NOW}'),
               (2,'${NOW}','UTILITIES','Electricity','Bill',3200,'${NOW}')`);

  if (withSuppliers) {
    exec(`INSERT INTO "Supplier" ("id","name","phone","email","balance","createdAt","updatedAt")
          VALUES (1,'Pak Distributors','0300-5556667','sales@pakdist.pk',5000,'${NOW}','${NOW}'),
                 (2,'Beauty Depot','0300-7778889',NULL,0,'${NOW}','${NOW}')`);
    exec(`INSERT INTO "Purchase" ("id","supplierId","totalAmount","paidAmount","status","createdAt")
          VALUES (1,1,10000,0,'UNPAID','${NOW}'),(2,2,4500,4500,'PAID','${NOW}')`);
    exec(`INSERT INTO "PurchaseItem" ("id","purchaseId","productId","quantity","unitCost","total")
          VALUES (1,1,1,50,200,10000),(2,2,2,15,300,4500)`);
    exec(`INSERT INTO "SupplierPayment" ("id","supplierId","amount","description","createdAt")
          VALUES (1,1,4500,'Part payment','${NOW}')`);
    exec(`INSERT INTO "SupplierPaymentAllocation" ("id","supplierPaymentId","purchaseId","amount","createdAt")
          VALUES (1,1,2,4500,'${NOW}')`);
  }

  if (withIdempotency) {
    exec(`UPDATE "Sale" SET "idempotencyKey"='11111111-1111-4111-8111-111111111111' WHERE "id"=1`);
    exec(`UPDATE "Purchase" SET "idempotencyKey"='22222222-2222-4222-8222-222222222222' WHERE "id"=1`);
    exec(`UPDATE "KhataTransaction" SET "idempotencyKey"='33333333-3333-4333-8333-333333333333' WHERE "id"=1`);
    exec(`UPDATE "SupplierPayment" SET "idempotencyKey"='44444444-4444-4444-8444-444444444444' WHERE "id"=1`);
  }
}

export const SCENARIOS = {
  A: {
    key: 'A',
    title: 'no supplier/purchase tables',
    build({ dbPath, migrationsDir }) {
      applyMigrations(migrationsDir, dbPath, 7);
      const db = openWritable(dbPath);
      seedData(db, { withSuppliers: false, withIdempotency: false });
      db.close();
    },
  },
  B: {
    key: 'B',
    title: 'all five supplier/purchase tables exist',
    build({ dbPath, migrationsDir }) {
      applyMigrations(migrationsDir, dbPath, 8);
      const db = openWritable(dbPath);
      seedData(db, { withSuppliers: true, withIdempotency: false });
      db.close();
    },
  },
  C: {
    key: 'C',
    title: 'only some supplier/purchase tables exist',
    build({ dbPath, migrationsDir }) {
      applyMigrations(migrationsDir, dbPath, 7);
      const db = openWritable(dbPath);
      db.exec(`CREATE TABLE "Supplier" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "balance" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);`);
      db.exec(`CREATE INDEX "Supplier_name_idx" ON "Supplier"("name");`);
      db.exec(`CREATE TABLE "Purchase" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "supplierId" INTEGER NOT NULL,
    "totalAmount" REAL NOT NULL,
    "paidAmount" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'UNPAID',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Purchase_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);`);
      db.exec(`CREATE INDEX "Purchase_supplierId_idx" ON "Purchase"("supplierId");`);
      db.exec(`CREATE INDEX "Purchase_createdAt_idx" ON "Purchase"("createdAt");`);
      seedData(db, { withSuppliers: false, withIdempotency: false });
      db.exec(`INSERT INTO "Supplier" ("id","name","phone","email","balance","createdAt","updatedAt")
        VALUES (1,'Pak Distributors','0300-5556667','sales@pakdist.pk',5000,'${NOW}','${NOW}'),
               (2,'Beauty Depot','0300-7778889',NULL,0,'${NOW}','${NOW}')`);
      db.exec(`INSERT INTO "Purchase" ("id","supplierId","totalAmount","paidAmount","status","createdAt")
        VALUES (1,1,10000,0,'UNPAID','${NOW}'),(2,2,4500,4500,'PAID','${NOW}')`);
      db.close();
    },
  },
  D: {
    key: 'D',
    title: 'all tables exist, some idempotency columns are missing',
    build({ dbPath, migrationsDir }) {
      applyMigrations(migrationsDir, dbPath, 8);
      const db = openWritable(dbPath);
      db.exec(`ALTER TABLE "Sale" ADD COLUMN "idempotencyKey" TEXT;`);
      db.exec(`CREATE UNIQUE INDEX "Sale_idempotencyKey_key" ON "Sale"("idempotencyKey");`);
      db.exec(`CREATE TABLE "Counter" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" INTEGER NOT NULL
);`);
      seedData(db, { withSuppliers: true, withIdempotency: false });
      db.exec(`UPDATE "Sale" SET "idempotencyKey"='11111111-1111-4111-8111-111111111111' WHERE "id"=1`);
      db.exec(`INSERT INTO "Counter" ("key","value") VALUES ('invoice-2026',42)`);
      db.close();
    },
  },
  E: {
    key: 'E',
    title: 'all columns exist, unique indexes are missing',
    build({ dbPath, migrationsDir }) {
      applyMigrations(migrationsDir, dbPath, 12);
      const db = openWritable(dbPath);
      db.exec(`DROP INDEX "Sale_idempotencyKey_key";`);
      db.exec(`DROP INDEX "Purchase_idempotencyKey_key";`);
      db.exec(`DROP INDEX "KhataTransaction_idempotencyKey_key";`);
      db.exec(`DROP INDEX "SupplierPayment_idempotencyKey_key";`);
      db.exec(`DROP INDEX "User_email_idx";`);
      seedData(db, { withSuppliers: true, withIdempotency: true });
      db.close();
    },
  },
  F: {
    key: 'F',
    title: 'structurally incorrect columns and foreign keys',
    build({ dbPath, migrationsDir }) {
      applyMigrations(migrationsDir, dbPath, 12);
      const db = openWritable(dbPath);
      seedData(db, { withSuppliers: true, withIdempotency: true });
      db.close();
      damageSchema(dbPath);
    },
  },
  G: {
    key: 'G',
    title: 'migration history partially initialized',
    build({ dbPath, migrationsDir }) {
      applyMigrations(migrationsDir, dbPath, 8);
      const db = openWritable(dbPath);
      db.exec(`ALTER TABLE "Sale" ADD COLUMN "idempotencyKey" TEXT;`);
      db.exec(`CREATE UNIQUE INDEX "Sale_idempotencyKey_key" ON "Sale"("idempotencyKey");`);
      seedData(db, { withSuppliers: true, withIdempotency: false });
      db.exec(`UPDATE "Sale" SET "idempotencyKey"='11111111-1111-4111-8111-111111111111' WHERE "id"=1`);
      db.close();
      writeHistory(dbPath, migrationsDir);
    },
  },
};

/** Deterministic "legacy damage": wrong types, wrong defaults, wrong FKs, extras. */
export function damageSchema(dbPath) {
  const db = openWritable(dbPath);
  const rebuild = (name, createSql, columns, indexes) => {
    db.exec('PRAGMA foreign_keys=OFF;');
    db.exec('PRAGMA legacy_alter_table=ON;');
    db.exec(createSql);
    db.exec(
      `INSERT INTO "new_${name}" (${columns.map((c) => `"${c}"`).join(', ')}) SELECT ${columns
        .map((c) => `"${c}"`)
        .join(', ')} FROM "${name}";`,
    );
    db.exec(`DROP TABLE "${name}";`);
    db.exec(`ALTER TABLE "new_${name}" RENAME TO "${name}";`);
    for (const idx of indexes) db.exec(idx);
    db.exec('PRAGMA legacy_alter_table=OFF;');
    db.exec('PRAGMA foreign_keys=ON;');
  };

  rebuild(
    'Sale',
    `CREATE TABLE "new_Sale" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "invoiceNo" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "subtotal" REAL NOT NULL,
    "discount" REAL NOT NULL,
    "total" TEXT NOT NULL,
    "recognizedAmount" REAL NOT NULL DEFAULT 0,
    "cashReceived" REAL,
    "paymentMethod" TEXT NOT NULL,
    "customerId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Sale_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`,
    ['id', 'invoiceNo', 'idempotencyKey', 'subtotal', 'discount', 'total', 'recognizedAmount', 'cashReceived', 'paymentMethod', 'customerId', 'createdAt'],
    [
      'CREATE UNIQUE INDEX "Sale_invoiceNo_key" ON "Sale"("invoiceNo");',
      'CREATE UNIQUE INDEX "Sale_idempotencyKey_key" ON "Sale"("idempotencyKey");',
      'CREATE INDEX "Sale_customerId_idx" ON "Sale"("customerId");',
    ],
  );

  rebuild(
    'Purchase',
    `CREATE TABLE "new_Purchase" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "supplierId" INTEGER NOT NULL,
    "totalAmount" REAL NOT NULL,
    "paidAmount" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'UNPAID',
    "idempotencyKey" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Purchase_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE NO ACTION ON UPDATE CASCADE
);`,
    ['id', 'supplierId', 'totalAmount', 'paidAmount', 'status', 'idempotencyKey', 'createdAt'],
    [
      'CREATE UNIQUE INDEX "Purchase_idempotencyKey_key" ON "Purchase"("idempotencyKey");',
      'CREATE INDEX "Purchase_supplierId_idx" ON "Purchase"("supplierId");',
      'CREATE INDEX "Purchase_createdAt_idx" ON "Purchase"("createdAt");',
    ],
  );

  rebuild(
    'SupplierPaymentAllocation',
    `CREATE TABLE "new_SupplierPaymentAllocation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "supplierPaymentId" INTEGER NOT NULL,
    "purchaseId" INTEGER NOT NULL,
    "amount" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupplierPaymentAllocation_supplierPaymentId_fkey" FOREIGN KEY ("supplierPaymentId") REFERENCES "SupplierPayment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SupplierPaymentAllocation_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
    ['id', 'supplierPaymentId', 'purchaseId', 'amount', 'createdAt'],
    [
      'CREATE INDEX "SupplierPaymentAllocation_supplierPaymentId_idx" ON "SupplierPaymentAllocation"("supplierPaymentId");',
      'CREATE INDEX "SupplierPaymentAllocation_purchaseId_idx" ON "SupplierPaymentAllocation"("purchaseId");',
    ],
  );

  rebuild(
    'PaymentAllocation',
    `CREATE TABLE "new_PaymentAllocation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "paymentId" INTEGER NOT NULL,
    "saleId" INTEGER NOT NULL,
    "amount" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "KhataTransaction" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "PaymentAllocation_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);`,
    ['id', 'paymentId', 'saleId', 'amount', 'createdAt'],
    [
      'CREATE INDEX "PaymentAllocation_paymentId_idx" ON "PaymentAllocation"("paymentId");',
      'CREATE INDEX "PaymentAllocation_saleId_idx" ON "PaymentAllocation"("saleId");',
      'CREATE UNIQUE INDEX "PaymentAllocation_paymentId_saleId_key" ON "PaymentAllocation"("paymentId", "saleId");',
    ],
  );

  rebuild(
    'PurchaseItem',
    `CREATE TABLE "new_PurchaseItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "purchaseId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" REAL NOT NULL,
    "total" REAL NOT NULL,
    CONSTRAINT "PurchaseItem_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
    ['id', 'purchaseId', 'productId', 'quantity', 'unitCost', 'total'],
    [
      'CREATE INDEX "PurchaseItem_purchaseId_idx" ON "PurchaseItem"("purchaseId");',
      'CREATE INDEX "PurchaseItem_productId_idx" ON "PurchaseItem"("productId");',
    ],
  );

  rebuild(
    'Product',
    `CREATE TABLE "new_Product" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "costPrice" TEXT NOT NULL,
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
);`,
    ['id', 'sku', 'barcode', 'name', 'type', 'costPrice', 'sellPrice', 'stock', 'lowStockAt', 'expiryDate', 'imageUrl', 'categoryId', 'brandId', 'createdAt', 'updatedAt'],
    [
      'CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");',
      'CREATE UNIQUE INDEX "Product_barcode_key" ON "Product"("barcode");',
      'CREATE INDEX "Product_name_idx" ON "Product"("name");',
      'CREATE INDEX "Product_barcode_idx" ON "Product"("barcode");',
      'CREATE INDEX "Product_type_idx" ON "Product"("type");',
    ],
  );

  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(`ALTER TABLE "Supplier" ADD COLUMN "legacyNote" TEXT;`);
  db.exec(`UPDATE "Supplier" SET "legacyNote" = 'imported from Excel' WHERE "id" = 1;`);
  db.exec(`CREATE TABLE "ZZ_legacy_audit" ("id" INTEGER PRIMARY KEY, "note" TEXT);`);
  db.exec(`INSERT INTO "ZZ_legacy_audit" ("id","note") VALUES (1,'keep me');`);
  db.exec('PRAGMA foreign_keys=ON;');
  db.close();
}

/**
 * A Prisma style _prisma_migrations table:
 *   1..8 applied, 9 recorded as failed, migration 3 recorded twice.
 * The ids are deterministic so that the generated plan is reproducible.
 */
export function writeHistory(dbPath, migrationsDir) {
  const db = openWritable(dbPath);
  db.exec(`CREATE TABLE "_prisma_migrations" (
    "id"                    TEXT PRIMARY KEY NOT NULL,
    "checksum"              TEXT NOT NULL,
    "finished_at"           DATETIME,
    "migration_name"        TEXT NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        DATETIME,
    "started_at"            DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count"   INTEGER UNSIGNED NOT NULL DEFAULT 0
)`);
  const checksum = (name) =>
    crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(migrationsDir, name, 'migration.sql')))
      .digest('hex');
  const insert = db.prepare(
    `INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","started_at","applied_steps_count","logs")
     VALUES (?,?,?,?,?,?,?)`,
  );
  const now = Date.now();
  MIGRATIONS.forEach((name, index) => {
    const failed = name === '20261111120000_add_idempotency_and_counter';
    insert.run(
      `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      checksum(name),
      failed ? null : now + index,
      name,
      now + index,
      1,
      failed ? 'Migration failed with error: duplicate column name: idempotencyKey' : null,
    );
  });
  insert.run(
    '00000000-0000-4000-8000-000000000900',
    checksum(MIGRATIONS[2]),
    now + 100,
    MIGRATIONS[2],
    now + 100,
    1,
    null,
  );
  db.close();
}
