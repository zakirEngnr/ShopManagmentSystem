import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import bcrypt from 'bcryptjs';

const adapter = new PrismaLibSql({ url: 'file:./shop.db' });
const prisma = new PrismaClient({ adapter });

const EMAIL = 'admin@shop.local';
const PASSWORD = process.env.ADMIN_PASSWORD;

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  
  const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
  
  if (existing) {
    await prisma.user.update({
      where: { email: EMAIL },
      data: {
        password: hash,
        isActive: true,
        failedAttempts: 0,
        lockedUntil: null,
        tokenVersion: { increment: 1 },
      },
    });
    console.log('✓ Password reset for existing user:', EMAIL);
  } else {
    await prisma.user.create({
      data: {
        name: 'Shop Owner',
        email: EMAIL,
        password: hash,
        role: 'ADMIN',
        isActive: true,
      },
    });
    console.log('✓ Admin user created:', EMAIL);
  }

  const verify = await prisma.user.findUnique({ where: { email: EMAIL } });
  const match = await bcrypt.compare(PASSWORD, verify.password);
  console.log('✓ Verification (configured admin password works):', match);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
