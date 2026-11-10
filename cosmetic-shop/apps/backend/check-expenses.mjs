import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
const adapter = new PrismaLibSql({ url: 'file:./shop.db' });
const prisma = new PrismaClient({ adapter });

const expenses = await prisma.expense.findMany({ orderBy: { id: 'asc' } });
console.log('--- ALL EXPENSES ---');
expenses.forEach(e => console.log(`ID: ${e.id} | Name: "${e.expenseName}" | Amount: ${e.amount} | Date: ${e.date.toISOString().split('T')[0]}`));

const total = expenses.reduce((sum, e) => sum + e.amount, 0);
console.log('--- TOTAL SUM ---');
console.log(total);

await prisma.$disconnect();
