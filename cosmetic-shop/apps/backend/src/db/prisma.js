import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set. Check apps/backend/.env');
}

const adapter = new PrismaLibSql({ url: databaseUrl });

const isProd = process.env.NODE_ENV === 'production';
const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
    log: isProd ? ['error'] : ['error', 'warn'],
  });

if (!isProd) {
  globalForPrisma.prisma = prisma;
}

export default prisma;
