import { test, expect, type Locator, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BACKUP_DIR = '/srv/sftp/prodbackup/uploads';
const BASE_URL = 'http://localhost:8069';
const MASTER_PASSWORD = 'ht8Hyann2JsqcWj6zDUZ9fgMVXo9s';
const UPLOAD_SETTLE_MS = 5 * 60 * 1000;
const EXPIRATION_PARAMETER_ID = 63;
const YEAR_PARAMETER_ID = 71;

// Finds the newest finished backup, e.g. Tech18_2026-10-01_00-43-45.zip, which is today's
// when it has arrived. The database name drops the changing minutes and seconds:
// Tech18_2026-10-01_00. Returns null when there is no finished backup at all.
function findLatestBackup() {
  const pattern = /^(Tech18_(\d{4}-\d{2}-\d{2})_\d{2})-\d{2}-\d{2}\.zip$/;
  const file = fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => pattern.test(name))
    // A file changed in the last few minutes may still be uploading.
    .filter((name) => Date.now() - fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs > UPLOAD_SETTLE_MS)
    // The date comes first in the name, so name order is date order.
    .sort()
    .pop();
  if (!file) {
    return null;
  }

  const [, dbName, date] = file.match(pattern)!;
  return { file, filePath: path.join(BACKUP_DIR, file), dbName, date };
}

function todaysDate() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

async function listDatabases(page: Page): Promise<string[]> {
  const response = await page.request.post(`${BASE_URL}/web/database/list`, {
    data: { jsonrpc: '2.0', method: 'call', params: {} },
  });
  const { result } = await response.json();
  if (!Array.isArray(result)) {
    throw new Error('Could not read the database list');
  }
  return result;
}

// Submits a database manager form and waits for Odoo to finish processing it.
async function submitForm(page: Page, submit: Locator, action: string) {
  const finished = page.waitForResponse(
    (response) => response.url().endsWith(action) && response.request().method() === 'POST',
    { timeout: 0 },
  );
  await submit.click();
  const response = await finished;
  await page.waitForLoadState('load');
  return response;
}

// Odoo re-renders the manager page with an alert when an action fails.
function pageError(page: Page) {
  return page.locator('.alert-danger').first().innerText({ timeout: 5000 }).catch(() => 'no details shown');
}

async function restoreDatabase(page: Page, filePath: string, dbName: string) {
  await page.goto(`${BASE_URL}/web/database/manager`);
  await page.getByRole('button', { name: 'Restore Database' }).click();
  await page.getByRole('button', { name: 'File' }).setInputFiles(filePath);
  await page.locator('#form_restore_db input[name="master_pwd"]').fill(MASTER_PASSWORD);
  await page.getByRole('textbox', { name: 'Database Name' }).fill(dbName);
  const response = await submitForm(page, page.getByRole('button', { name: 'Continue' }), '/web/database/restore');

  // Odoo redirects on success and re-renders the manager page with an alert on failure.
  if (response.status() < 300 || response.status() >= 400) {
    return pageError(page);
  }
  return null;
}

async function deleteDatabase(page: Page, dbName: string) {
  await page.goto(`${BASE_URL}/web/database/manager`);
  await page.locator(`.o_database_action[data-bs-target=".o_database_delete"][data-db="${dbName}"]`).click();
  await expect(page.locator('#dbname_delete')).toHaveValue(dbName);
  await page.locator('#form_drop_db input[name="master_pwd"]').fill(MASTER_PASSWORD);
  await submitForm(page, page.locator('#form_drop_db input[type="submit"]'), '/web/database/drop');

  if ((await listDatabases(page)).includes(dbName)) {
    throw new Error(`Delete of ${dbName} failed: ${await pageError(page)}`);
  }
}

// A failed restore can leave a database in the list that cannot be opened, so
// being listed is not enough: its login page has to load too.
async function isUsable(page: Page, dbName: string) {
  if (!(await listDatabases(page)).includes(dbName)) {
    return false;
  }
  await page.goto(`${BASE_URL}/web/login?db=${dbName}`).catch(() => null);
  return page
    .getByRole('textbox', { name: 'Email' })
    .waitFor({ timeout: 30_000 })
    .then(() => true, () => false);
}

// Removes a broken copy of today's database so that a later run can restore it again.
// The last database on the server is never deleted.
async function removeBrokenDatabase(page: Page, dbName: string) {
  const databases = await listDatabases(page);
  if (!databases.includes(dbName)) {
    return;
  }
  if (databases.length < 2) {
    throw new Error(`${dbName} cannot be opened, but it is the only database so it was not deleted`);
  }
  await deleteDatabase(page, dbName);
}

async function ensureRestored(page: Page, filePath: string, dbName: string) {
  if (await isUsable(page, dbName)) {
    return;
  }
  await removeBrokenDatabase(page, dbName);

  const error = await restoreDatabase(page, filePath, dbName);
  if (error || !(await isUsable(page, dbName))) {
    await removeBrokenDatabase(page, dbName);
    throw new Error(`Restore of ${dbName} failed, so nothing else was deleted: ${error ?? 'the database cannot be opened'}`);
  }
}

// Only runs after today's database has been logged in to, so the server always
// keeps at least one working database.
async function deleteOtherDatabases(page: Page, keep: string) {
  const databases = await listDatabases(page);
  if (!databases.includes(keep)) {
    throw new Error(`${keep} is not in the database list, so nothing was deleted`);
  }

  for (const dbName of databases.filter((name) => name !== keep)) {
    await deleteDatabase(page, dbName);
  }
}

async function logIn(page: Page, dbName: string) {
  const redirect = encodeURIComponent(`/odoo/system-parameters/${EXPIRATION_PARAMETER_ID}?debug=1`);
  await page.goto(`${BASE_URL}/web/login?db=${dbName}&redirect=${redirect}`);
  await page.getByRole('textbox', { name: 'Email' }).fill('admin');
  await page.getByRole('textbox', { name: 'Password Reset Password' }).click();
  await page.getByRole('textbox', { name: 'Password Reset Password' }).fill('Admin');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
}

// Saves the value that getNewValue returns for the parameter's current value.
// Returning null leaves it as it is, which also suits a second run on the same day:
// Odoo shows no save button when nothing has changed.
async function updateSystemParameter(page: Page, id: number, getNewValue: (current: string) => string | null) {
  await page.goto(`${BASE_URL}/odoo/system-parameters/${id}?debug=1`);
  const value = page.getByRole('textbox', { name: 'Value?' });
  await value.waitFor();

  const current = await value.inputValue();
  const newValue = getNewValue(current);
  if (newValue === null) {
    console.log(`System parameter ${id} is "${current}", left unchanged`);
    return;
  }

  await value.click();
  await value.press('ControlOrMeta+a');
  await value.fill(newValue);
  await page.getByRole('button', { name: 'Save manually' }).click();
  await expect(page.getByRole('button', { name: 'Save manually' })).toBeHidden({ timeout: 30_000 });
  console.log(`System parameter ${id} changed from "${current}" to "${newValue}"`);
}

async function updateSystemParameters(page: Page, dbName: string) {
  await logIn(page, dbName);
  await page.getByRole('textbox', { name: 'Value?' }).waitFor();

  // Only renewal changes to trial. Any other value, including trial, is left as it is.
  await updateSystemParameter(page, EXPIRATION_PARAMETER_ID, (current) => (current === 'renewal' ? 'trial' : null));

  const yearValue = `M${new Date().getFullYear()}`;
  await updateSystemParameter(page, YEAR_PARAMETER_ID, (current) => (current === yearValue ? null : yearValue));
}

test('test', async ({ page }) => {
  const backup = findLatestBackup();
  if (!backup) {
    // A missing backup is expected at either run, so this is a skip and not a failure.
    console.log(`No finished backup in ${BACKUP_DIR}, nothing was changed`);
    test.skip(true, 'No finished backup');
    return;
  }

  console.log(`Using backup ${backup.file}`);
  if (backup.date !== todaysDate()) {
    console.log(`WARNING: no finished backup for today, the newest one is from ${backup.date}`);
  }

  // Never go backwards, for example when today's file is removed after the 8:30 run restored it.
  const newer = (await listDatabases(page)).filter((name) => /^Tech18_\d{4}-\d{2}-\d{2}_\d{2}$/.test(name) && name > backup.dbName);
  if (newer.length > 0) {
    console.log(`${newer.join(', ')} is newer than this backup, nothing was changed`);
    test.skip(true, 'A newer database is already restored');
    return;
  }

  await ensureRestored(page, backup.filePath, backup.dbName);
  await updateSystemParameters(page, backup.dbName);
  await deleteOtherDatabases(page, backup.dbName);
});
