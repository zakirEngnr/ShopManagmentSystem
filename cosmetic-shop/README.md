# Cosmetic Shop Management System

Desktop app (Electron) for managing a cosmetic and artificial jewelry shop.
Offline-first, SQLite-backed, PKR currency, no tax.

## Stack
- Backend: Node.js + Express + Prisma + SQLite
- Frontend: React + Vite
- Desktop: Electron

## Dev
    pnpm install
    pnpm db:generate
    pnpm db:migrate
    pnpm db:seed
    pnpm dev

## Upgrading an existing shop.db (owner runs this, the agent never does)

New releases may add database migrations (for example the `tokenVersion`
column that powers session revocation). To upgrade the real shop database:

1. Stop the app.
2. Copy `apps/backend/shop.db` to a safe place (backup).
3. Set `DATABASE_URL` to the real database file, e.g.
   `DATABASE_URL="file:./shop.db"`.
4. Run `pnpm --filter backend prisma:deploy`.
5. Start the app and log in again (tokens issued before the `tokenVersion`
   release are rejected once; one re-login is expected).

Warnings:

* Starting the new code against an un-migrated database makes
  authenticated requests fail (the `tokenVersion` column is missing).
* `prisma:migrate` (`migrate dev --name init`) must never be used on the
  real database — it is a development command. Use `prisma:deploy` only.
