import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const adapter = new PrismaLibSql({ url: 'file:./shop.db' });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('Seeding test products into: file:./shop.db');

  let category = await prisma.category.findFirst({ where: { name: 'Test Cosmetics' } });
  if (!category) {
    category = await prisma.category.create({
      data: { name: 'Test Cosmetics', type: 'COSMETIC' }
    });
  }

  const existing = await prisma.product.count({ where: { sku: { startsWith: 'TEST-' } } });
  if (existing > 0) {
    console.log('Test products already exist. Skipping.');
    return;
  }

  await prisma.product.createMany({
    data: [
      {
        sku: 'TEST-LIP-001',
        barcode: '1000000000001',
        name: 'Test Lipstick Red',
        type: 'COSMETIC',
        costPrice: 200,
        sellPrice: 350,
        stock: 50,
        lowStockAt: 10,
        categoryId: category.id,
      },
      {
        sku: 'TEST-CREAM-002',
        barcode: '1000000000002',
        name: 'Test Face Cream',
        type: 'COSMETIC',
        costPrice: 400,
        sellPrice: 650,
        stock: 5,
        lowStockAt: 10,
        categoryId: category.id,
      },
      {
        sku: 'TEST-EARRING-003',
        barcode: '1000000000003',
        name: 'Test Gold Earrings',
        type: 'JEWELRY',
        costPrice: 300,
        sellPrice: 550,
        stock: 20,
        lowStockAt: 5,
        categoryId: category.id,
      }
    ]
  });

  const count = await prisma.product.count();
  console.log('Success. Total products in DB:', count);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
