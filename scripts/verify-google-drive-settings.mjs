import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

// A browser-only component check, with a mock IPC boundary. It does not log in
// to Google or claim to verify Electron safeStorage / real account sync.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.vite', 'drive-settings-qa');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'index.html'), '<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/.vite/drive-settings-qa/main.tsx"></script></body></html>');
await writeFile(path.join(directory, 'main.tsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SyncSettingsPage } from '../../src/renderer/SyncSettingsPage';
import { LocaleProvider } from '../../src/renderer/i18n';
import '../../src/renderer/styles.css';
let servers = [];
const callbacks = {
  syncListServers: async () => ({ok:true,value:servers}),
  syncSaveServer: async (input) => {
    window.__driveRequest = input;
    servers = [{id:'drive-1',baseUrl:'https://drive.google.com/drive/folders/fixture-folder',hasPassword:true,allowInsecureTls:false,googleDrive:{clientId:input.googleDrive.clientId,folderId:'fixture-folder'}}];
    return {ok:true,value:{id:'drive-1'}};
  },
  syncDeleteServer: async () => { servers=[]; return {ok:true}; },
  syncProbe: async () => ({ok:true,value:{auth:'oauth2',supportsContentTransfer:true,supportsEtagIfMatch:false,supportsDepthInfinity:true,supportsMove:true,supportsLock:false}}),
};
const locale = new URLSearchParams(location.search).get('locale') || 'zh-CN';
createRoot(document.getElementById('root')).render(<LocaleProvider initialPreference={locale}><main style={{maxWidth:900,margin:'24px auto',padding:24}}><h1>Serpent · {locale === 'en' ? 'Sync settings' : '同步设置'}</h1><SyncSettingsPage callbacks={callbacks} showCardSyncStatus onShowCardSyncStatusChange={()=>{}} /></main></LocaleProvider>);
`);
const server = await createServer({ configFile: path.join(root, 'vite.renderer.config.ts'),
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true,
    ...(process.env.SERPENT_QA_BROWSER_EXECUTABLE ? { executablePath: process.env.SERPENT_QA_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = server.resolvedUrls.local[0];
  for (const locale of ['zh-CN', 'en']) {
    await page.goto(`${base}.vite/drive-settings-qa/index.html?locale=${locale}`);
    await page.locator('#sync-provider').selectOption('google-drive');
    await page.locator('#google-client-id').fill('fixture.apps.googleusercontent.com');
    await page.locator('#google-client-secret').fill('FAKE-CLIENT-SECRET');
    await page.locator('#google-folder-id').fill('fixture-folder');
    const button = page.getByRole('button', { name: locale === 'en' ? 'Connect Google Drive' : '连接 Google Drive', exact: true });
    await button.click();
    await page.getByText('Google Drive · fixture-folder', { exact: true }).waitFor();
    const input = await page.evaluate(() => globalThis.__driveRequest);
    assert.deepEqual(input.googleDrive, {clientId:'fixture.apps.googleusercontent.com',clientSecret:'FAKE-CLIENT-SECRET',folderId:'fixture-folder'});
    await page.getByRole('button', { name: locale === 'en' ? 'Edit' : '编辑', exact: true }).click();
    assert.equal(await page.locator('#google-client-secret').inputValue(), '');
    assert.equal(await page.locator('#google-client-id').isDisabled(), true);
    assert.equal(await page.locator('#google-folder-id').isDisabled(), true);
    assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= globalThis.innerWidth), true);
    await page.screenshot({ path: path.join(directory, `settings-${locale}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log(`Google Drive settings browser check passed (zh-CN + en). Screenshots: ${directory}`);
} finally {
  await browser?.close();
  await server.close();
}
