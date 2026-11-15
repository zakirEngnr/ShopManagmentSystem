import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
const adapter = new PrismaLibSql({ url: 'file:./shop.db' });
const prisma = new PrismaClient({ adapter });

const users = await prisma.user.findMany();
console.log('Users in DB:', users.length);
users.forEach(u => console.log(`- ${u.email} | isActive: ${u.isActive} | role: ${u.role}`));

await prisma.$disconnect();
