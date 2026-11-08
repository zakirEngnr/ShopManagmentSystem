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

## Uploaded images

Product images are stored as files in `UPLOAD_DIR` (default
`apps/backend/uploads`), which is ignored by git. Image files are NOT part of
`shop.db` and are NOT included in a shop.db backup: back up `shop.db` and the
`uploads` folder together. Restoring only `shop.db` leaves product images
missing (product `imageUrl` values will point to absent files).

`UPLOAD_DIR` must be a dedicated folder. The server refuses to start if it
contains anything except image files (`<uuid>.jpg|png|webp`), their `.tmp`
uploads, or tolerated OS files (`.gitkeep`, `.DS_Store`, `Thumbs.db`,
`desktop.ini`) — for example it refuses a directory containing `shop.db`,
`.env`, or `*.sqlite` files.
