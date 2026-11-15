# db-reconcile — SQLite schema reconciliation for cosmetic-shop

A **read-only-first** tool that compares a SQLite database against
`prisma/schema.prisma` and reports, per database object, whether it is
`CORRECT`, `MISSING`, `MISMATCH` or `EXTRA`. It can produce a deterministic,
reviewable SQL plan and — for **disposable databases only** — execute it.

The tool is deliberately conservative:

* it never picks a database for you and never reads `DATABASE_URL` to choose a
  target;
* the default mode opens the database **read-only**;
* it never drops a table, a column or a row;
* it never writes to `_prisma_migrations`;
* it refuses the live `shop.db` and every backup of it, in every mode.

---

## 1. Quick start

```bash
cd apps/backend

# read-only audit of a COPY of the database (never the live file)
npm run db:reconcile -- --db /tmp/audit-copy.db

# same, but with an explicit output directory
npm run db:reconcile -- --db /tmp/audit-copy.db --out /tmp/reconcile-report

# plan + report only, no writes (default mode)
npm run db:reconcile -- --db /tmp/audit-copy.db --plan

# EXECUTE the plan - disposable databases only
npm run db:reconcile -- --db /tmp/throwaway.db --apply --yes-disposable
```

Exit codes: `0` nothing to do, `1` usage/environment error, `2` differences
found, `3` the run was blocked (pre-check failed, unsupported structure or
detected data loss).

---

## 2. Modes and safety model

| Mode | Database opened | Writes | When to use |
|---|---|---|---|
| `--audit` (default) | read-only | none | first look at any database |
| `--plan` | read-only | none (writes the report + SQL file) | reviewing the exact SQL |
| `--apply` | read/write | yes | **disposable copies only** |

`--apply` is refused unless **both** conditions hold:

1. the resolved path is inside a disposable root (the OS temp directory by
   default, or a directory passed with `--disposable-root`), and
2. `--yes-disposable` is given, which is the explicit confirmation that the
   file is a throw-away copy.

The live database is protected independently of that:

* any path whose file name matches `shop.db` or `shop.db.*` is refused
  (`shop.db`, `shop.db.BACKUP-…`, `shop.db.pre-restore-…`, `shop.db.bak.…`),
* everything inside `apps/backend/backups/` is refused,
* the check runs in **every** mode, including the read-only audit.

The resolved absolute path, its size and its SHA-256 are printed before
anything else happens, so it is always obvious which file was inspected.

---

## 3. Running a read-only audit

```bash
npm run db:reconcile -- --db /tmp/audit-copy.db --out /tmp/audit
```

1. **Make a copy first.** The audit is read-only, but auditing the live file
   while the backend is running can still see a half-written WAL state. Stop
   the app, copy the file (see §6), and audit the copy.
2. Run the command above.
3. Read the console summary and the two output files.

Options:

| Option | Meaning |
|---|---|
| `--db <path>` | **required**; the SQLite file to audit |
| `--out <dir>` | output directory (default: a fresh directory in the temp dir) |
| `--schema <path>` | `schema.prisma` (default: `apps/backend/prisma/schema.prisma`) |
| `--migrations <dir>` | migrations directory (default: `apps/backend/prisma/migrations`) |
| `--expected-ddl <file>` | use a previously generated Prisma DDL file instead of calling the Prisma CLI |
| `--disposable-root <dir>` | an additional directory that counts as disposable |
| `--yes-disposable` | required for `--apply` |
| `--json` | print the JSON report to stdout instead of the summary |

The expected schema is generated with

```
prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
```

run against an isolated throw-away `DATABASE_URL`, and cached by the hash of
`schema.prisma` plus the Prisma version, so repeated runs are fast and
reproducible.

---

## 4. Reading the JSON report

`reconciliation-report.json` contains:

| Field | Meaning |
|---|---|
| `target` | resolved path, size, mtime and SHA-256 of the inspected file |
| `database` | SQLite version, journal mode, `PRAGMA integrity_check` and `PRAGMA foreign_key_check` results |
| `expected` | the expected object counts and the delta between the migration chain and `schema.prisma` |
| `classification.before` | counts per status (`CORRECT`/`MISSING`/`MISMATCH`/`EXTRA`/`UNSUPPORTED`) |
| `classification.after` | the same counts after `--apply` |
| `classification.findings` | every non-`CORRECT` object with a human readable reason |
| `plan` | the ordered plan, one entry per step, with its SQL and pre/post-checks |
| `history` | the migration history report (read-only, manual actions only) |
| `data` | row-count comparison and fingerprint deltas after `--apply` |
| `apply` | the execution log, the backups that were written and the abort reason (if any) |

A finding looks like this:

```json
{
  "kind": "foreignKey",
  "table": "SupplierPaymentAllocation",
  "name": "SupplierPaymentAllocation_purchaseId_fkey",
  "status": "MISMATCH",
  "details": ["ON DELETE: expected RESTRICT, found CASCADE"]
}
```

`kind` is one of `table`, `column`, `primaryKey`, `index`, `foreignKey`,
`trigger`, `view`.

---

## 5. Reviewing the SQL plan

`reconciliation-plan.sql` is the exact statement list, annotated with the
reason for each step:

```sql
-- [S05] TABLE_REBUILD: rebuild table "PaymentAllocation"
-- reason: PaymentAllocation: ON UPDATE: expected CASCADE, found NO ACTION
-- PRE-CHECK  no orphan paymentId values in PaymentAllocation (FK -> KhataTransaction.id)
--            SELECT COUNT(*) AS violations FROM "PaymentAllocation" t LEFT JOIN ...
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
PRAGMA legacy_alter_table=ON;
CREATE TABLE "new_PaymentAllocation" ( ... );
INSERT INTO "new_PaymentAllocation" (...) SELECT ... FROM "PaymentAllocation";
DROP TABLE "PaymentAllocation";
ALTER TABLE "new_PaymentAllocation" RENAME TO "PaymentAllocation";
CREATE INDEX "PaymentAllocation_paymentId_idx" ON "PaymentAllocation"("paymentId");
...
PRAGMA legacy_alter_table=OFF;
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
```

Review rules:

* a `DROP TABLE` is only ever allowed inside a rebuild that copies every row
  into the replacement table first — the test suite asserts this;
* `SAFE_ADDITIVE_DDL` steps are `CREATE TABLE` / `ALTER TABLE … ADD COLUMN`
  and cannot lose data;
* `TABLE_REBUILD` steps carry their pre-checks (orphans, NOT NULL violations,
  duplicates) and their post-checks (`foreign_key_check`, `integrity_check`,
  row count);
* `REPORT_ONLY` steps have no SQL at all: they are extra tables, columns,
  indexes, triggers or views that are **preserved** and reported, never
  dropped;
* `MANUAL_DATA_REPAIR` steps are blocking: the run stops and asks for a human
  decision.

Run the plan by hand only after you have read it. The tool's own `--apply`
does exactly what the file says, in the same order.

---

## 6. Creating and verifying a backup

The tool takes its own backups before it writes anything:

* one backup of the whole database before the first write
  (`<db>.<label>.<timestamp>.bak` in the output directory's `backups/`), and
* one additional backup before **every** table rebuild.

The backup is created with `VACUUM INTO`, which produces a consistent,
compacted copy that does not need the WAL side files.

To create a backup of the live database by hand, stop the backend first and
run:

```bash
# stop the backend, then
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('apps/backend/shop.db');db.exec(\"VACUUM INTO 'apps/backend/backups/shop.db.manual-<timestamp>'\");db.close()"
```

Verify the backup before you rely on it:

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('apps/backend/backups/shop.db.manual-<timestamp>',{readOnly:true});console.log(db.prepare('PRAGMA integrity_check').all());console.log(db.prepare('SELECT count(*) c FROM Sale').get());db.close()"
```

`PRAGMA integrity_check` must print `ok`, and the row counts must match the
live database.

**The tool never replaces a database file.** It never copies one over another
and never moves a file into place. Replacing the live database is a separate,
manual, human-approved operation.

---

## 7. Why production reconciliation needs explicit approval

The tool can only be pointed at a disposable database:

* writing to the live database is refused by the disposable-root check;
* the live database path is refused by the protected-path check;
* `--apply` needs an explicit `--yes-disposable` confirmation.

This is deliberate. A reconciliation can rewrite tables, and a table rewrite
on a database that contains the shop's real sales data is not something a
script should be able to do unattended.

The production procedure is therefore:

1. stop the backend;
2. back up the live database and verify the backup (§6);
3. copy the database to a disposable directory;
4. run the audit against the copy and read the report;
5. run `--apply` against the copy and verify the result (classification after
   = `MISSING: 0`, `MISMATCH: 0`, no data loss);
6. review the SQL plan and the migration history report;
7. apply the verified changes to the live database **by hand**, one reviewed
   statement group at a time, with the backup from step 2 ready;
8. restart the backend and smoke test.

---

## 8. Why `prisma migrate dev` and `prisma migrate reset` are prohibited

Both commands can destroy the live database:

* `prisma migrate dev` detects drift between the database and the migration
  history and answers with
  *"We need to reset the SQLite database … All data will be lost."* — in
  interactive mode it will happily do it.
* `prisma migrate reset` drops the schema and re-applies the migrations.
  That is exactly the "delete everything" operation.

`prisma migrate deploy` is safer but still not a reconciliation tool:

* on a database whose schema exists but has no migration history it fails
  with **P3005** and changes nothing;
* on a database whose schema is ahead of its history it fails with
  **P3018** and leaves a failed migration record behind;
* it never fixes a column type, a default or a foreign key action.

So the rule for this repository is:

| Command | Against the live `shop.db` |
|---|---|
| `prisma migrate dev` | **never** (can reset and delete everything) |
| `prisma migrate reset` | **never** (drops the schema) |
| `prisma migrate deploy` | only after the migration history has been reconciled by hand |
| `prisma migrate resolve --applied/--rolled-back` | only after the schema has been verified, one migration at a time |
| `prisma db push` | never on the live database (it is not history aware) |

---

## 9. Migration history: report only

The tool **never** modifies `_prisma_migrations`. It reports:

* `MISSING` — no record for a migration;
* `APPLIED` — exactly one finished record;
* `FAILED` — a record with `finished_at IS NULL` (a partially applied
  migration);
* `ROLLED_BACK` — a record with `rolled_back_at` set;
* duplicates — more than one applied record for the same migration;
* checksum mismatches — `sha256(migration.sql)` differs from the recorded
  checksum (the migration file was edited after it was applied);
* orphan records — a record for a migration that no longer exists on disk;
* partial execution — some of the objects a migration introduces are present
  and some are not.

Every entry lists **manual** actions (all prefixed with `MANUAL:`), for
example:

```
MANUAL: prisma migrate resolve --applied 20261110150000_add_purchase_supplier_tables
MANUAL: prisma migrate resolve --rolled-back 20261111120000_add_idempotency_and_counter
MANUAL: prisma migrate deploy
MANUAL: DELETE FROM "_prisma_migrations" WHERE id = '<surplus-row-id>';
```

Marking a migration as applied is only correct **after** the schema objects it
creates have been verified in the database — the tool checks exactly that and
says so in the finding.

---

## 10. What the tool refuses to do

* it never drops a table, a column, an index, a trigger or a view;
* it never deletes a row;
* it never writes to the migration history;
* it never repairs orphan rows, duplicate values or unexpected NULLs by
  itself — it reports them and stops;
* it refuses to rewrite a table that uses a structure it cannot reproduce
  safely (generated columns, `WITHOUT ROWID`, `STRICT`, `CHECK` constraints):
  the table is reported as `UNSUPPORTED` and is left alone;
* it never replaces a database file.

---

## 11. SQLite notes (why the rebuild looks like it does)

A rebuild is the only way to change a column type, a default, a nullability
or a foreign key action in SQLite, and `DROP TABLE` has side effects:

| Side effect | How the tool handles it |
|---|---|
| child rows are deleted by `ON DELETE CASCADE` | `PRAGMA foreign_keys=OFF` while the table is dropped (and the run is refused if the database already violates its foreign keys) |
| the triggers of the table are dropped | the trigger DDL is captured and re-created verbatim after every rebuild |
| the indexes of the table are dropped | expected **and** extra indexes are re-created |
| the `AUTOINCREMENT` high-water mark is lost | `sqlite_sequence` is captured before and restored afterwards, so the next id never goes backwards |
| a dependent view makes `ALTER TABLE … RENAME` fail | the rebuild uses `PRAGMA legacy_alter_table=ON`, which keeps dependent views working |
| `PRAGMA foreign_keys` is a no-op inside a transaction | rebuilds run outside a transaction, on purpose |

Every rebuild is preceded by a full backup of the database and is followed by
`PRAGMA foreign_key_check`, `PRAGMA integrity_check` and a row-count and
fingerprint comparison.

### 11.1 What an interrupted rebuild leaves behind

The rebuild cannot run inside a transaction, so it is **not atomic**. The
behaviour after an interruption at every stage was measured
(`test/rebuild-interruption.test.mjs`):

| Interrupted after | `Sale` table | `foreign_key_check` | view | trigger | `sqlite_sequence` | state |
|---|---|---|---|---|---|---|
| backup created | intact | clean | works | present | intact | consistent |
| pragmas set | intact | clean | works | present | intact | consistent |
| replacement table created | intact | clean | works | present | intact | consistent |
| data copied | intact | clean | works | present | intact | consistent |
| **original table dropped** | **MISSING** | **4 violations** | **broken** | **lost** | **lost** | **damaged** |
| replacement renamed | back | clean | works | **lost** | restored by the applier | **silently missing a trigger** |
| indexes restored | back | clean | works | **lost** | restored | **silently missing a trigger** |

Two lessons:

* `PRAGMA integrity_check` stays `ok` even when the table is gone — it does
  not validate foreign key references. `PRAGMA foreign_key_check` and a
  row-count comparison are the meaningful signals.
* an interruption between the rename and the trigger restore silently removes
  a business rule. The applier therefore verifies at the end of the run that
  every trigger that existed before still exists, and aborts if one is gone.

**Recovery**: every stage is recoverable, but only by restoring the file:

```bash
# stop the backend first
cp <output-dir>/backups/<db>.<label>.<timestamp>.bak /path/to/db.sqlite
rm -f /path/to/db.sqlite-wal /path/to/db.sqlite-shm
```

The `-wal` / `-shm` side files must be removed, otherwise SQLite may replay a
stale write-ahead log over the restored file. The broken intermediate state
(`new_Sale` instead of `Sale`) cannot be repaired with SQL alone, because the
table name, the triggers and the sequence are all part of the damage.

---

## 12. Tests

```bash
npm run db:reconcile:test
```

The suite builds the seven legacy scenarios (A–G) as disposable databases in
the temp directory and asserts, for each of them:

* every expected object is classified correctly before the run;
* after `--apply` there is no `MISSING`, `MISMATCH` or `UNSUPPORTED` object;
* no data loss: row counts and per-column fingerprints are preserved, and no
  table is dropped;
* every expected index and foreign key (including the `ON DELETE` /
  `ON UPDATE` actions) exists and matches;
* `PRAGMA integrity_check` is `ok` and `PRAGMA foreign_key_check` is empty;
* all 18 models are queryable through the real Prisma client and all 42
  application level checks pass (real login, authenticated API reads);
* the plan is deterministic;
* the migration history is never modified;
* the run stops on orphan rows, duplicate unique values and unsupported
  structures;
* the safety guards refuse `shop.db`, `--apply` without `--yes-disposable` and
  `--apply` outside a disposable root.

---

## 13. Layout

```
scripts/db-reconcile/
  reconcile.mjs            CLI entry point
  lib/paths.mjs            protected paths, disposable roots, file identity
  lib/sqlite.mjs           connections, pragmas, trigger-aware SQL splitting
  lib/ddl.mjs              quoting, DDL parsing, default normalisation
  lib/introspect.mjs       tables/columns/indexes/FKs/triggers/views/sequences
  lib/expected.mjs         expected schema (Prisma intent + migration chain)
  lib/compare.mjs          CORRECT / MISSING / MISMATCH / EXTRA classification
  lib/plan.mjs             deterministic plan builder
  lib/rebuild.mjs          hardened SQLite table rebuild
  lib/apply.mjs            executor: pre-checks, backups, post-checks
  lib/fingerprint.mjs      streaming data fingerprints
  lib/history.mjs          report-only migration history planner
  lib/report.mjs           JSON report and SQL plan writers
  lib/engine.mjs           the reconciliation engine used by CLI and tests
  lib/scenarios.mjs        disposable scenario fixtures A–G
  app-check.mjs            application level checks (models + HTTP API)
  test/reconcile.test.mjs          reconciliation test suite
  test/rebuild-interruption.test.mjs  rebuild interruption / recovery tests
```
