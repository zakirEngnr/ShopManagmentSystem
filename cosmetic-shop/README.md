# Cosmetic & Jewelry Shop Management System

Offline, single-shop owner application for managing sales, purchases, suppliers,
khata (customer credit), expenses, and reports. Currency: PKR.

## Architecture

- **Frontend:** React + Vite (`apps/frontend`)
- **Backend:** Express + Prisma 7 + SQLite/libSQL (`apps/backend`)

## Environment Variables

### Backend (`apps/backend/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | HTTP server port |
| `HOST` | `127.0.0.1` | Host the backend binds to. Only change to `0.0.0.0` if you deliberately want other devices on the shop network to connect. |
| `DATABASE_URL` | `file:./shop.db` | SQLite database file path |
| `JWT_SECRET` | *(required)* | Signing key for session tokens. Generate with: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `UPLOAD_DIR` | `./uploads` | Directory for uploaded product images |
| `ADMIN_EMAIL` | *(required)* | Seed admin email |
| `ADMIN_PASSWORD` | *(required, 12+ chars)* | Seed admin password |
| `BACKUP_DIR` | `./backups` | Directory for database backup files |
| `BACKUP_KEEP` | `30` | Number of newest backups to retain |
| `BACKUP_COPY_DIR` | *(optional)* | Second copy destination (e.g. a USB drive mount point) |

## Profit Rule: Accrual Basis for Credit (KHATA) Sales

Revenue, discount and COGS for **every** sale — cash or KHATA (credit) — are
counted on the **sale date** using `Sale.total`. This means a KHATA sale shows
full revenue and profit on the day it is made, even if the customer pays later.

`recognizedAmount` and payment allocations are kept strictly as a record of
how much has been **collected**. They do **not** affect revenue, COGS, or
profit.

Manual debt entries for BUSINESS/PERSONAL customers do **not** affect revenue,
COGS, or profit.

### Worked Example

A Rs. 1,000 credit sale (cost Rs. 600) is made on **1 March**. The customer
pays Rs. 1,000 on **20 April**.

| Report | Revenue | COGS | Profit | Collected | Outstanding |
|--------|---------|------|--------|-----------|-------------|
| March | Rs. 1,000 | Rs. 600 | Rs. 400 | Rs. 0 | Rs. 1,000 |
| April | Rs. 0 | Rs. 0 | Rs. 0 | Rs. 1,000 | Rs. 0 |

The April report shows Rs. 1,000 collected but no extra revenue — the revenue
was already recognised in March.

## Backups

Backups are created using SQLite's online `VACUUM INTO` statement, which is
safe to run on a live database. Backup files go to `BACKUP_DIR` (default
`apps/backend/backups/`) and are named `shop-YYYYMMDD-HHmmss.db`.

- On server start, a backup is created if the newest one is older than 24 hours.
- A re-check runs every 24 hours (unref'd interval, does not block shutdown).
- Retention keeps the newest `BACKUP_KEEP` (default 30) backups; older ones
  are deleted.
- Each backup is verified with `PRAGMA integrity_check` after creation.
- If `BACKUP_COPY_DIR` is set, each verified backup is also copied there.
- Backup files are **never served over HTTP** and are excluded from git.

### REST API (authenticated)

- `POST /api/backups` — create a backup now
- `GET /api/backups` — list backup names, sizes, and timestamps

There is **no download** or delete-by-path endpoint. Backup files must be
copied directly from the `BACKUP_DIR` on the server's filesystem.

### Restore

`node scripts/restore-backup.mjs <backup-file>`

The restore script:
1. Refuses to run if the app is currently listening (checked via a TCP
   connect to the configured `PORT`). Stop the app first.
2. Copies the current `shop.db` to `shop.db.pre-restore-<timestamp>`.
3. Overwrites `shop.db` with the backup file.
4. Runs `PRAGMA integrity_check` and prints the result.

## Owner-Run Upgrade Steps

1. **Back up** the current `shop.db` and the whole repository.
2. Run `scripts/reconcile-money.mjs <db-path>` to detect any money residue.
3. Run `scripts/fix-money-residue.mjs --dry-run` to review proposed fixes.
4. Run `scripts/fix-money-residue.mjs --apply` to apply fixes.
5. Restart the server.
6. Verify reports match expectations.

## Secret Rotation

If the repository or a zip was ever shared, rotate the JWT secret and admin
password:

1. Generate a new secret:
   `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
2. Update `JWT_SECRET` in `.env`.
3. Update `ADMIN_PASSWORD` in `.env` (12+ characters) and re-seed, or change
   the password through the application.
4. Restart the server.
5. All users must log in again (existing JWTs become invalid).

## Keeping Secrets Out of the Repository

- `apps/backend/.env` is git-ignored and must never be committed.
- `.env.example` contains only obvious placeholders (`CHANGE_ME_...`).
- Database backup files (`*.db`, `*.BACKUP*`, `apps/backend/backups/`) are
  git-ignored. Six historical backup files were removed from tracking in this
  repo (kept on disk, removed from git index).
- If a backup file or secret was ever committed, use `git filter-repo` to
  rewrite history (see below), and rotate all exposed secrets.

### History Rewrite Guidance (filter-repo)

Before any history rewrite, take a mirror backup:

```bash
git clone --mirror <repo-url> repo-backup
```

**Warning:** `git filter-repo` rewrites all commit hashes and invalidates every
collaborator's clone. Do **not** run it if the repository is shared with
anyone else unless they are prepared to re-clone and rebase their work.

To remove a tracked backup file from history:

```bash
git filter-repo --path apps/backend/shop.db.BACKUP-20261109-123638 --invert-paths --force
```

Repeat for each tracked backup file. After the rewrite, all collaborators must
fresh-clone the repository.

## Development

```bash
# Install dependencies
pnpm install

# Run backend in dev mode
pnpm --filter backend dev

# Run frontend dev server
pnpm --filter frontend dev

# Run backend tests
cd apps/backend && JWT_SECRET=<secret> NODE_ENV=test node --test

# Generate Prisma client
cd apps/backend && pnpm prisma:generate
```

## Testing

All backend tests use throwaway SQLite databases in `os.tmpdir()` via
`test-support/tempDb.js`. The production database (`apps/backend/shop.db`)
is never touched by tests or by this agent.
