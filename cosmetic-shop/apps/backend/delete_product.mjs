import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
async function main() {
  // List all products first
  const products = await p.product.findMany();
  console.log('Current products:');
  products.forEach(prod => console.log(' -', prod.id, '|', prod.sku, '|', prod.name));
  
  // Delete the product with id 1 (or you can specify by SKU)
  const result = await p.product.delete({ where: { id: 1 } });
  console.log('Deleted product:', result.sku, result.name);
  
  // List remaining products
  const remaining = await p.product.findMany();
  console.log('Remaining products:', remaining.length);
  remaining.forEach(prod => console.log(' -', prod.id, '|', prod.sku, '|', prod.name));
}
main().then(() => p.$disconnect()).catch(e => { console.error(e); p.$disconnect(); process.exit(1); });
