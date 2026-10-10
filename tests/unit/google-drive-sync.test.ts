import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

import { GoogleDriveDriver } from '../../src/worker/sync/google-drive-driver';
import { SyncEngine, type SyncLibraryPort, type SyncRootConfig } from '../../src/worker/sync/sync-engine';
import { emptySyncAssetMetadata, type SyncAssetMetadata } from '../../src/worker/sync/sync-metadata';
import { GoogleDriveFixture } from './google-drive-fixture';

const hash = (body: Buffer) => createHash('sha256').update(body).digest('hex');
class Device implements SyncLibraryPort {
  assets = new Map<string, { path: string; body: Buffer; metadata: SyncAssetMetadata }>();
  cache: string | null = null;
  copies: Buffer[] = [];
  async syncSnapshot(libraryId: string) {
    return { library: { libraryId, displayName: '作品集' }, assets: [...this.assets].map(([syncId, value]) => ({
      syncId, assetId: syncId, relativePath: value.path, contentHash: hash(value.body), size: value.body.length,
      modifiedAt: '2026-10-10T00:00:00Z', metadata: value.metadata,
    })) };
  }
  async readLocalAssetContent(_libraryId: string, id: string) { return this.assets.get(id)!.body; }
  async readLocalAssetMetadata(_libraryId: string, id: string) { return this.assets.get(id)!.metadata; }
  async applyRemoteAssetMetadata(_libraryId: string, id: string, metadata: SyncAssetMetadata) { this.assets.get(id)!.metadata = metadata; }
  async applySyncContentUpdate(_libraryId: string, id: string, path: string, body: Buffer) {
    const previous = this.assets.get(id);
    this.assets.set(id, { path, body, metadata: previous?.metadata ?? emptySyncAssetMetadata() });
    return { assetId: id, created: !previous };
  }
  async applySyncRelocate(_libraryId: string, id: string, path: string) { this.assets.get(id)!.path = path; }
  async applySyncRecycle(_libraryId: string, id: string) { this.assets.delete(id); }
  async applySyncConflictCopy(_libraryId: string, path: string, body: Buffer, name: string) {
    const syncId = `copy-${this.copies.length}`;
    this.copies.push(body);
    this.assets.set(syncId, { path: `${name}-${path.split('/').at(-1)}`, body, metadata: emptySyncAssetMetadata() });
    return { syncId, contentHash: hash(body), size: body.length };
  }
  async readSyncManifestCache() { return this.cache; }
  async writeSyncManifestCache(_libraryId: string, body: string) { this.cache = body; }
}

function devices() {
  const remote = new GoogleDriveFixture();
  const config: SyncRootConfig = { id: 'drive', baseUrl: 'https://drive.google.com', googleDrive: remote.credentials };
  const make = () => {
    const device = new Device();
    const engine = new SyncEngine(device, { deviceId: Math.random().toString(), now: () => '2026-10-10T00:00:00.000Z' });
    engine.buildDriver = () => new GoogleDriveDriver(remote.credentials, { fetch: remote.fetch });
    return { device, engine, sync: () => engine.syncOnce('library-1', config) };
  };
  return { remote, config, a: make(), b: make() };
}

it('syncs managed binary assets, metadata and renames between two sequential devices', async () => {
  const { a, b } = devices();
  const original = { path: '材质/填充.ai', body: Buffer.from([1, 0, 255]), metadata: { tags: ['保温', '剖面'], description: '8 mm', rating: 4, favorite: true } };
  a.device.assets.set('asset-1', original);
  await a.sync();
  await b.sync();
  expect(b.device.assets.get('asset-1')).toEqual(original);
  b.device.assets.get('asset-1')!.metadata = { ...original.metadata, tags: ['平面'], description: 'new description' };
  b.device.assets.get('asset-1')!.path = '新分类/图样.ai';
  await b.sync();
  await a.sync();
  expect(a.device.assets.get('asset-1')).toEqual(b.device.assets.get('asset-1'));
});

it('preserves a conflict copy when both offline devices edited the same asset before sequential sync', async () => {
  const { a, b } = devices();
  a.device.assets.set('asset-1', { path: 'file.ai', body: Buffer.from('base'), metadata: emptySyncAssetMetadata() });
  await a.sync(); await b.sync();
  a.device.assets.get('asset-1')!.body = Buffer.from('edit on A');
  b.device.assets.get('asset-1')!.body = Buffer.from('edit on B');
  await a.sync();
  const result = await b.sync();
  expect(result.conflicts).toHaveLength(1);
  const preserved = [b.device.assets.get('asset-1')!.body.toString(), ...b.device.copies.map((body) => body.toString())];
  expect(preserved).toContain('edit on A');
  expect(preserved).toContain('edit on B');
});

it('does not treat a duplicate manifest, malformed manifest or permission failure as an empty remote', async () => {
  for (const kind of ['duplicate', 'malformed', 'permission']) {
    const { a, remote } = devices();
    a.device.assets.set('asset-1', { path: 'file.ai', body: Buffer.from('base'), metadata: emptySyncAssetMetadata() });
    await a.sync();
    const manifest = [...remote.files.values()].find((file) => file.name === 'manifest.json')!;
    if (kind === 'duplicate') remote.add('manifest.json', manifest.parents[0], manifest.body);
    if (kind === 'malformed') manifest.body = Buffer.from('not JSON');
    if (kind === 'permission') remote.failNext = 403;
    const before = remote.calls.length;
    await expect(a.sync()).rejects.toThrow();
    expect(remote.calls.slice(before).filter((call) => call.method !== 'GET')).toHaveLength(0);
  }
});

it('fails the session if an asset upload is denied, without publishing an empty manifest or caching success', async () => {
  const { a, remote, config } = devices();
  a.device.assets.set('asset-1', { path: 'file.ai', body: Buffer.from('base'), metadata: emptySyncAssetMetadata() });
  const fetcher: typeof fetch = async (url, init) => String(url).includes('/upload/')
    ? new Response('{}', { status: 403 }) : remote.fetch(url, init);
  a.engine.buildDriver = () => new GoogleDriveDriver(remote.credentials, { fetch: fetcher });
  await expect(a.engine.syncOnce('library-1', config)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(a.device.cache).toBeNull();
  expect([...remote.files.values()].some((file) => file.name === 'manifest.json')).toBe(false);
});
