import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import bcrypt from 'bcryptjs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL not set');
const adapter = new PrismaLibSql({ url: databaseUrl });
const prisma = new PrismaClient({ adapter });

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var for seed: ${name}`);
  return v;
}

async function main() {
  console.log('[seed] starting...');

  const adminEmail = requireEnv('ADMIN_EMAIL');
  const adminPassword = requireEnv('ADMIN_PASSWORD');

  if (adminPassword.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  }

  const passwordHash = await bcrypt.hash(adminPassword, 10);
  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });

  if (!existing) {
    await prisma.user.create({
      data: {
        name: 'Shop Owner',
        email: adminEmail,
        password: passwordHash,
        role: 'ADMIN',
        isActive: true,
      },
    });
    console.log('[seed] admin created:', adminEmail);
  } else {
    console.log('[seed] admin already exists; leaving password untouched:', adminEmail);
    console.log('[seed] to rotate the password, delete the user and re-seed,');
    console.log('[seed] or use a future admin "reset password" flow.');
  }

  const settings = [
    { key: 'shop.name', value: 'My Cosmetic Shop' },
    { key: 'currency', value: 'PKR' },
    { key: 'currencySymbol', value: 'Rs.' },
  ];
  for (const s of settings) {
    await prisma.setting.upsert({
      where: { key: s.key },
      update: {},
      create: s,
    });
  }
  console.log('[seed] settings ok:', settings.length);

  const cosmeticCat = await prisma.category.upsert({
    where: { name: 'Cosmetics' },
    update: {},
    create: { name: 'Cosmetics', type: 'COSMETIC' },
  });
  const jewelryCat = await prisma.category.upsert({
    where: { name: 'Jewelry' },
    update: {},
    create: { name: 'Jewelry', type: 'JEWELRY' },
  });
  console.log('[seed] categories ok');

  for (const name of ['Generic', 'Local Brand']) {
    await prisma.brand.upsert({ where: { name }, update: {}, create: { name } });
  }
  const genericBrand = await prisma.brand.findUnique({ where: { name: 'Generic' } });

  const samples = [
    { sku: 'COS-001', barcode: '1000000000001', name: 'Lipstick Red', type: 'COSMETIC', costPrice: 200, sellPrice: 350, stock: 20, lowStockAt: 5, categoryId: cosmeticCat.id, brandId: genericBrand.id },
    { sku: 'COS-002', barcode: '1000000000002', name: 'Face Cream 50ml', type: 'COSMETIC', costPrice: 400, sellPrice: 650, stock: 15, lowStockAt: 5, categoryId: cosmeticCat.id, brandId: genericBrand.id },
    { sku: 'JWL-001', barcode: null, name: 'Golden Earrings Peacock', type: 'JEWELRY', costPrice: 300, sellPrice: 550, stock: 10, lowStockAt: 3, categoryId: jewelryCat.id, brandId: genericBrand.id },
    { sku: 'JWL-002', barcode: null, name: 'Silver Anklet Pair', type: 'JEWELRY', costPrice: 250, sellPrice: 450, stock: 8, lowStockAt: 3, categoryId: jewelryCat.id, brandId: genericBrand.id },
  ];
  for (const p of samples) {
    await prisma.product.upsert({ where: { sku: p.sku }, update: {}, create: p });
  }
  console.log('[seed] products ok:', samples.length);
  console.log('[seed] done.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
