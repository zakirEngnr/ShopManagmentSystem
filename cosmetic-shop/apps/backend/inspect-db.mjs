import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const adapter = new PrismaLibSql({ url: 'file:./shop.db' });
const prisma = new PrismaClient({ adapter });

console.log('Users:', await prisma.user.count());
console.log('Products:', await prisma.product.count());
console.log('Sales:', await prisma.sale.count());
console.log('SaleItems:', await prisma.saleItem.count());
console.log('Expenses:', await prisma.expense.count());
console.log('StockAdjusts:', await prisma.stockAdjust.count());
console.log('Categories:', await prisma.category.count());
console.log('Brands:', await prisma.brand.count());

await prisma.$disconnect();
