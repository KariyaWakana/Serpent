import { describe, expect, it } from 'vitest';

import { GoogleDriveDriver } from '../../src/worker/sync/google-drive-driver';
import { createSyncDriver } from '../../src/worker/sync/create-driver';
import { GoogleDriveFixture } from './google-drive-fixture';

function setup() {
  const remote = new GoogleDriveFixture();
  const driver = new GoogleDriveDriver(remote.credentials, { fetch: remote.fetch });
  return { remote, driver };
}

describe('Google Drive HTTP contract', () => {
  it('selects Drive without interpreting its folder URL as WebDAV', () => {
    const remote = new GoogleDriveFixture();
    expect(createSyncDriver({ baseUrl: 'not-a-webdav-url', googleDrive: remote.credentials })).toBeInstanceOf(GoogleDriveDriver);
  });

  it('refreshes once across polling drivers and refreshes again after a 401', async () => {
    const { remote, driver } = setup();
    expect(await driver.probe()).toMatchObject({ auth: 'oauth2', supportsEtagIfMatch: false });
    await new GoogleDriveDriver(remote.credentials, { fetch: remote.fetch }).probe();
    expect(remote.refreshes).toBe(1);
    remote.failNext = 401;
    await driver.probe();
    expect(remote.refreshes).toBe(2);
  });

  it('round-trips arbitrary binary and Chinese paths without duplicate creates', async () => {
    const { remote, driver } = setup();
    const bytes = Buffer.from([0, 255, 13, 10, 120]);
    await driver.write("材质/石'材.ai", bytes);
    expect((await driver.read("材质//石'材.ai")).body).toEqual(bytes);
    await driver.write("材质/石'材.ai", Buffer.from('updated'));
    expect((await driver.read("材质/石'材.ai")).body.toString()).toBe('updated');
    expect([...remote.files.values()].filter((file) => file.name === "石'材.ai")).toHaveLength(1);
  });

  it('paginates, traverses nested directories and scopes all paths to the configured root', async () => {
    const { remote, driver } = setup();
    for (let n = 0; n < 5; n++) remote.add(`asset-${n}`);
    remote.add('outside', 'root');
    await driver.write('图案/细部/填充.ai', Buffer.from('fill'));
    const listed = await driver.list('', 'infinity');
    expect(listed.some((entry) => entry.path === '图案/细部/填充.ai')).toBe(true);
    expect(listed.some((entry) => entry.path === 'asset-4')).toBe(true);
    expect(listed.some((entry) => entry.path === 'outside')).toBe(false);
    expect(remote.calls.some((call) => call.url.searchParams.has('pageToken'))).toBe(true);
  });

  it('rejects ambiguous siblings, even when duplicates are on different pages', async () => {
    const { remote, driver } = setup();
    remote.pageSize = 1;
    remote.add('same'); remote.add('same');
    await expect(driver.read('same')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(driver.write('same', Buffer.from('overwrite'))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(remote.calls.filter((call) => call.method !== 'GET' && call.url.host !== 'oauth2.googleapis.com')).toHaveLength(0);
  });

  it('moves by file ID and sends deletes to Drive trash', async () => {
    const { remote, driver } = setup();
    const original = remote.add('one.ai');
    await driver.move('one.ai', '资料/two.ai');
    expect((await driver.read('资料/two.ai')).body.toString()).toBe('asset');
    expect(remote.files.get(original.id)?.name).toBe('two.ai');
    await driver.delete('资料/two.ai');
    expect(remote.files.get(original.id)?.trashed).toBe(true);
    expect(await driver.exists('资料/two.ai')).toBe(false);
    await driver.delete('absent');
  });

  it('uses resumable chunks and recovers an interrupted accepted chunk by querying the session', async () => {
    const { remote, driver } = setup();
    remote.failUploadOnce = true;
    const bytes = Buffer.alloc(9 * 1024 * 1024, 137);
    await driver.write('large.3dm', bytes);
    expect((await driver.read('large.3dm')).body).toEqual(bytes);
    expect(remote.calls.some((call) => call.headers.get('content-range') === `bytes */${bytes.length}`)).toBe(true);
    expect(remote.uploadOffset).toBe(bytes.length);
  });

  it('does not leak bearer tokens to an untrusted resumable redirect', async () => {
    const { remote } = setup();
    const fetcher: typeof fetch = async (url, init) => String(url).includes('uploadType=resumable')
      ? new Response('{}', { headers: { location: 'https://attacker.invalid/upload/drive/session' } }) : remote.fetch(url, init);
    const driver = new GoogleDriveDriver(remote.credentials, { fetch: fetcher });
    await expect(driver.write('large', Buffer.alloc(6 * 1024 * 1024))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(remote.calls.some((call) => call.url.host === 'attacker.invalid')).toBe(false);
  });

  it('rejects traversal, root mutations and unsupported stale WebDAV conditions before writing', async () => {
    const { remote, driver } = setup();
    for (const path of ['../outside', '/outside', 'a/../b', 'C:\\outside']) {
      await expect(driver.write(path, Buffer.from('x'))).rejects.toMatchObject({ code: 'INVALID_URL' });
    }
    await expect(driver.delete('')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(driver.move('', 'elsewhere')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(driver.write('a/b', Buffer.from('x'), { ifMatch: 'old-webdav-etag' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(remote.calls).toHaveLength(0);
  });

  it('maps deterministic errors without exposing response bodies', async () => {
    const { remote, driver } = setup();
    remote.failNext = 403;
    await expect(driver.probe()).rejects.toMatchObject({ code: 'PERMISSION_DENIED', retryable: false });
    remote.failNext = 429;
    await expect(driver.probe()).rejects.toMatchObject({ code: 'LOCKED', retryable: true });
  });

  it('discovers only app-marked roots and refuses ambiguous roots', async () => {
    const { remote, driver } = setup();
    const id = await driver.ensureAppRoot();
    expect(id).not.toBe('sync-root');
    expect(await driver.ensureAppRoot()).toBe(id);
    const duplicate = remote.add('Serpent', 'root', Buffer.alloc(0), 'application/vnd.google-apps.folder');
    duplicate.appProperties = { serpentSyncRoot: '1' };
    await expect(driver.ensureAppRoot()).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
