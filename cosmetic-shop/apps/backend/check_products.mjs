import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const products = await p.product.findMany();
console.log(products.length + ' products found:');
products.forEach(prod => console.log(' - ID:', prod.id, '| SKU:', prod.sku, '| Name:', prod.name));
p.$disconnect();
