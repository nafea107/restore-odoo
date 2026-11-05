import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'restore.ts',
  // Restoring a backup of about 1 GB takes far longer than the default 30 seconds.
  timeout: 60 * 60 * 1000,
  // Stops a stuck click from holding the run until the next scheduled one starts.
  use: { actionTimeout: 5 * 60 * 1000 },
});
