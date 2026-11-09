const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.product.findMany().then(r => { console.log(r.length + ' products'); r.forEach(prod => console.log(' -', prod.sku, prod.name))}).finally(() => p.$disconnect());
