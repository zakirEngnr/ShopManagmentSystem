-- Add soft-delete and audit history support to Expense.
ALTER TABLE "Expense" ADD COLUMN "updatedAt" DATETIME;
ALTER TABLE "Expense" ADD COLUMN "deletedAt" DATETIME;

CREATE TABLE "ExpenseHistory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "expenseId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "snapshot" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExpenseHistory_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ExpenseHistory_expenseId_idx" ON "ExpenseHistory"("expenseId");
CREATE INDEX "ExpenseHistory_createdAt_idx" ON "ExpenseHistory"("createdAt");
CREATE INDEX "Expense_deletedAt_idx" ON "Expense"("deletedAt");