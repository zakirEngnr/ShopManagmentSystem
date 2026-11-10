-- Add customer type column
ALTER TABLE "Customer" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'RETAIL';
CREATE INDEX "Customer_type_idx" ON "Customer"("type");