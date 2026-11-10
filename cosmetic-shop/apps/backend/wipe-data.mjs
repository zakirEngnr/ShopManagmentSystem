import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const adapter = new PrismaLibSql({ url: 'file:./shop.db' });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('Wiping all data except admin user...\n');

  // Delete in reverse dependency order to avoid foreign key errors
  const khata = await prisma.khataTransaction.deleteMany();
  console.log('KhataTransactions deleted:', khata.count);

  const saleItems = await prisma.saleItem.deleteMany();
  console.log('SaleItems deleted:', saleItems.count);

  const sales = await prisma.sale.deleteMany();
  console.log('Sales deleted:', sales.count);

  const stock = await prisma.stockAdjust.deleteMany();
  console.log('StockAdjusts deleted:', stock.count);

  const expenses = await prisma.expense.deleteMany();
  console.log('Expenses deleted:', expenses.count);

  const products = await prisma.product.deleteMany();
  console.log('Products deleted:', products.count);

  const brands = await prisma.brand.deleteMany();
  console.log('Brands deleted:', brands.count);

  const categories = await prisma.category.deleteMany();
  console.log('Categories deleted:', categories.count);

  const customers = await prisma.customer.deleteMany();
  console.log('Customers deleted:', customers.count);

  const settings = await prisma.setting.deleteMany();
  console.log('Settings deleted:', settings.count);

  const users = await prisma.user.count();
  console.log('\n✅ Everything wiped. Admin users preserved:', users);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
