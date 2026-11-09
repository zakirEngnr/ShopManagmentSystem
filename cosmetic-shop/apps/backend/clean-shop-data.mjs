import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const adapter = new PrismaLibSql({ url: 'file:./shop.db' });
const prisma = new PrismaClient({ adapter });

console.log('Cleaning shop data (preserving admin user)...');

// Delete in reverse dependency order
const deletedSaleItems = await prisma.saleItem.deleteMany();
const deletedSales = await prisma.sale.deleteMany();
const deletedStockAdjusts = await prisma.stockAdjust.deleteMany();
const deletedExpenses = await prisma.expense.deleteMany();
const deletedProducts = await prisma.product.deleteMany();
const deletedBrands = await prisma.brand.deleteMany();
const deletedCategories = await prisma.category.deleteMany();
const deletedSettings = await prisma.setting.deleteMany();

console.log('');
console.log('✓ Cleanup complete:');
console.log('  SaleItems deleted:', deletedSaleItems.count);
console.log('  Sales deleted:', deletedSales.count);
console.log('  StockAdjusts deleted:', deletedStockAdjusts.count);
console.log('  Expenses deleted:', deletedExpenses.count);
console.log('  Products deleted:', deletedProducts.count);
console.log('  Brands deleted:', deletedBrands.count);
console.log('  Categories deleted:', deletedCategories.count);
console.log('  Settings deleted:', deletedSettings.count);
console.log('');

// Verify final state
const userCount = await prisma.user.count();
console.log('Users preserved:', userCount);
console.log('');
console.log('✓ Shop is clean and ready for the shopkeeper.');
console.log('  Admin login still works.');

await prisma.$disconnect();
