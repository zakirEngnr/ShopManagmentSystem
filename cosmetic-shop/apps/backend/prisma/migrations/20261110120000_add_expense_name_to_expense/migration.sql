-- Add expenseName column to Expense for cumulative tracking by expense head/payee
ALTER TABLE "Expense" ADD COLUMN "expenseName" TEXT;
CREATE INDEX "Expense_expenseName_idx" ON "Expense"("expenseName");