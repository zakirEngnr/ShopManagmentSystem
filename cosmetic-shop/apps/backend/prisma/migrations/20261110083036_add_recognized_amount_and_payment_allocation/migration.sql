-- Add recognizedAmount to Sale: tracks how much revenue has been recognized
-- from this sale (cash sales = total immediately; KHATA sales = 0 until paid)
ALTER TABLE "Sale" ADD COLUMN "recognizedAmount" REAL NOT NULL DEFAULT 0;

-- PaymentAllocation: tracks which payments settle which sales (FIFO allocation)
CREATE TABLE "PaymentAllocation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "paymentId" INTEGER NOT NULL,
    "saleId" INTEGER NOT NULL,
    "amount" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "KhataTransaction" ("id") ON DELETE CASCADE,
    CONSTRAINT "PaymentAllocation_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "PaymentAllocation_paymentId_saleId_key" ON "PaymentAllocation"("paymentId", "saleId");
CREATE INDEX "PaymentAllocation_paymentId_idx" ON "PaymentAllocation"("paymentId");
CREATE INDEX "PaymentAllocation_saleId_idx" ON "PaymentAllocation"("saleId");