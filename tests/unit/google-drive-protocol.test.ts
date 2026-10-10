import { expect, it } from 'vitest';

import { parseRendererRequest, parseWorkerRequest } from '../../src/shared/protocol/requests';
import { parseRendererResult } from '../../src/shared/protocol/responses';

it('accepts OAuth setup from the renderer but never accepts a renderer-supplied refresh token', () => {
  const setup = { type: 'sync.servers.upsert.request', baseUrl: 'https://drive.google.com', googleDrive: { clientId: 'desktop-client', folderId: 'folder' } };
  expect(parseRendererRequest(setup)).toEqual(setup);
  expect(() => parseRendererRequest({ ...setup, googleDrive: { ...setup.googleDrive, refreshToken: 'not-from-main' } })).toThrow();
});

it('preserves Main-to-worker Drive credentials for all sync command variants', () => {
  const googleDrive = { clientId: 'desktop-client', refreshToken: 'main-only-token', clientSecret: 'client-secret', folderId: 'folder' };
  for (const type of ['sync.probe', 'sync.list-remote-libraries', 'sync.preview', 'sync.run', 'sync.poll-remote', 'sync.open-remote-library']) {
    const extra = type === 'sync.open-remote-library' ? { libraryId: 'library', displayName: 'Library', directoryName: 'Library', selectedParentPath: 'C:\\local' }
      : ['sync.preview', 'sync.run', 'sync.poll-remote'].includes(type) ? { libraryId: 'library', deviceId: 'device' } : {};
    expect(parseWorkerRequest({ requestId: 'request', command: { type, baseUrl: 'https://drive.google.com', googleDrive, ...extra } }).command).toMatchObject({ googleDrive });
  }
});

it('accepts public Drive summaries and rejects credentials crossing back to the renderer', () => {
  const summary = { id: 'drive', baseUrl: 'https://drive.google.com', hasPassword: true, allowInsecureTls: false, googleDrive: { clientId: 'desktop-client', folderId: 'folder' } };
  expect(parseRendererResult({ ok: true, type: 'sync.servers.listed', servers: [summary] })).toMatchObject({ servers: [summary] });
  expect(() => parseRendererResult({ ok: true, type: 'sync.servers.listed', servers: [{ ...summary, googleDrive: { ...summary.googleDrive, refreshToken: 'must-not-leak' } }] })).toThrow();
});
