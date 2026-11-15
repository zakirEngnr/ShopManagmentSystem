import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTempDb } from './test-support/tempDb.js';
import { createUser, signToken } from './test-support/auth.js';
import http from 'node:http';

const backendDir = path.resolve('.');
const backendUrl = pathToFileURL(backendDir + path.sep).href;
const ctx = await createTempDb({ prefix: 'race-', backendDir });
const db = await import(backendUrl + 'src/db/prisma.js');
const prisma = db.prisma;
const admin = await createUser(prisma, { role: 'ADMIN', tag: 'race' });
const token = signToken(admin);
const app = (await import(backendUrl + 'src/app.js')).createApp();

const customer = await prisma.customer.create({ data: { name: 'Race', phone: '+1000000999', balance: 100 } });
const id = customer.id;

function doReq(payload) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      const r = http.request({ host:'127.0.0.1', port, path:`/api/customers/${id}/payment`, method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+token }}, (res) => {
        let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ s.close(); resolve({status:res.statusCode, body: d?JSON.parse(d):null }); });
      });
      r.write(JSON.stringify(payload)); r.end();
    });
  });
}

for (let round=0; round<8; round++) {
  await prisma.customer.update({ where: { id }, data: { balance: 100 } });
  await prisma.khataTransaction.deleteMany({ where: { customerId: id } });
  const [a, b] = await Promise.all([doReq({amount:100,description:'a'}), doReq({amount:100,description:'b'})]);
  const fin = await prisma.customer.findUnique({ where: { id } });
  const cnt = await prisma.khataTransaction.count({ where: { customerId: id, type:'PAYMENT' } });
  console.log(`round ${round}: statuses=[${a.status},${b.status}] balance=${Number(fin.balance)} paymentTxs=${cnt}`);
}
await prisma.$disconnect();
ctx.cleanup();
