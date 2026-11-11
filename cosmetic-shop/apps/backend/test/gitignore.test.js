// Task 2: verify historical backup files (and the future backups directory)
// are ignored by .gitignore. Shells out to `git check-ignore --no-index`
// which returns exit code 0 when a path matches an ignore pattern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = '/home/zakir-ahmad/Desktop/ShopManagmentSystem/cosmetic-shop';

// Historical tracked backup filenames removed from tracking in this task, plus
// a representative file inside the backups directory (covered by Task 3's
// apps/backend/backups/ rule).
const PATHS = [
  'apps/backend/shop.db.BACKUP-20261109-123638',
  'apps/backend/shop.db.BACKUP-BEFORE-ACCOUNTING-RECOGNITION',
  'apps/backend/shop.db.BACKUP-BEFORE-CUSTOMER-TYPE',
  'apps/backend/shop.db.BACKUP-BEFORE-EXPENSE-NAME',
  'apps/backend/shop.db.BACKUP-BEFORE-TEST-PRODUCTS',
  'apps/backend/shop.db.pre-tokenversion-backup',
  'apps/backend/backups/shop-20240101-000000.db',
];

for (const p of PATHS) {
  test(`${p} is git-ignored`, () => {
    let status;
    try {
      execFileSync('git', ['check-ignore', '--no-index', p], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
      });
      status = 0;
    } catch (err) {
      status = err.status;
    }
    assert.equal(status, 0, `expected ${p} to be git-ignored`);
  });
}
