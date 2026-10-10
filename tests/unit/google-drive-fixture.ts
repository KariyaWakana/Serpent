import { randomUUID } from 'node:crypto';

import type { GoogleDriveCredentials } from '../../src/shared/google-drive-sync';

interface File {
  id: string; name: string; mimeType: string; parents: string[];
  body: Buffer; trashed?: boolean; appProperties?: Record<string, string>;
}
const folder = 'application/vnd.google-apps.folder';
const json = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), { status, headers });

/** An in-memory HTTP-contract fixture; it does not use any real account/token. */
export class GoogleDriveFixture {
  readonly credentials: GoogleDriveCredentials = { clientId: 'test.apps.googleusercontent.com', refreshToken: randomUUID(), folderId: 'sync-root' };
  readonly files = new Map<string, File>();
  readonly calls: { url: URL; method: string; headers: Headers; body: RequestInit['body'] }[] = [];
  pageSize = 2;
  refreshes = 0;
  failNext?: number;
  failUploadOnce = false;
  uploadOffset = 0;
  private session?: { metadata: Partial<File>; id?: string; chunks: Buffer[] };

  constructor() {
    this.files.set('sync-root', { id: 'sync-root', name: 'Serpent', mimeType: folder, parents: ['root'], body: Buffer.alloc(0) });
  }

  add(name: string, parent = 'sync-root', body: Buffer = Buffer.from('asset'), mimeType = 'application/octet-stream'): File {
    const file = { id: randomUUID(), name, mimeType, parents: [parent], body };
    this.files.set(file.id, file);
    return file;
  }

  readonly fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    this.calls.push({ url, method, headers, body: init.body });
    if (url.host === 'oauth2.googleapis.com') {
      this.refreshes++;
      return json({ access_token: 'fixture-access-token', expires_in: 3600 });
    }
    if (this.failNext) { const status = this.failNext; this.failNext = undefined; return json({}, status); }
    const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
    const data = init.body && typeof init.body === 'string' ? JSON.parse(init.body) as Partial<File> : {};
    const fields = (file: File) => ({ ...file, body: undefined, size: String(file.body.length), modifiedTime: '2026-10-10T01:00:00Z' });
    if (url.searchParams.get('uploadType') === 'resumable') {
      this.session = { metadata: data, id: id === 'files' ? undefined : id, chunks: [] };
      this.uploadOffset = 0;
      return json({}, 200, { location: 'https://www.googleapis.com/upload/drive/v3/session' });
    }
    if (id === 'session') {
      if (!this.session) return json({}, 404);
      if (headers.get('content-range')?.startsWith('bytes */')) {
        return new Response(null, { status: 308, headers: this.uploadOffset ? { range: `bytes=0-${this.uploadOffset - 1}` } : {} });
      }
      const chunk = Buffer.from(init.body as Uint8Array);
      this.session.chunks.push(chunk);
      this.uploadOffset += chunk.length;
      if (this.failUploadOnce) { this.failUploadOnce = false; throw new Error('fixture connection reset after chunk accepted'); }
      const total = Number(headers.get('content-range')?.split('/')[1]);
      if (this.uploadOffset < total) return new Response(null, { status: 308, headers: { range: `bytes=0-${this.uploadOffset - 1}` } });
      const body = Buffer.concat(this.session.chunks);
      const file = this.session.id ? this.files.get(this.session.id)! : this.add(this.session.metadata.name!, this.session.metadata.parents![0], body);
      file.body = body;
      return json({ id: file.id });
    }
    if (url.searchParams.get('uploadType') === 'multipart') {
      const payload = Buffer.from(init.body as Uint8Array);
      const boundary = headers.get('content-type')!.split('boundary=')[1];
      const metaStart = payload.indexOf('\r\n\r\n') + 4;
      const metaEnd = payload.indexOf(`\r\n--${boundary}`, metaStart);
      const metadata = JSON.parse(payload.subarray(metaStart, metaEnd).toString()) as Partial<File>;
      const bodyStart = payload.indexOf('\r\n\r\n', metaEnd) + 4;
      const body = payload.subarray(bodyStart, payload.length - Buffer.byteLength(`\r\n--${boundary}--\r\n`));
      const file = method === 'PATCH' ? this.files.get(id)! : this.add(metadata.name!, metadata.parents![0], body);
      file.body = body;
      return json({ id: file.id }, method === 'PATCH' ? 200 : 201);
    }
    if (id === 'files' && method === 'GET') {
      const query = url.searchParams.get('q') ?? '';
      const parent = /'((?:\\.|[^'])*)' in parents/.exec(query)?.[1]?.replace(/\\(.)/g, '$1');
      const name = /name = '((?:\\.|[^'])*)'/.exec(query)?.[1]?.replace(/\\(.)/g, '$1');
      const files = [...this.files.values()].filter((file) => !file.trashed && (!parent || file.parents.includes(parent)) && (name === undefined || file.name === name)
        && (!query.includes('appProperties has') || file.appProperties?.serpentSyncRoot === '1'));
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      return json({ files: files.slice(start, start + this.pageSize).map(fields), ...(files.length > start + this.pageSize ? { nextPageToken: String(start + this.pageSize) } : {}) });
    }
    if (id === 'files' && method === 'POST') {
      const file = this.add(data.name!, data.parents![0], Buffer.alloc(0), data.mimeType);
      file.appProperties = data.appProperties;
      return json(fields(file), 201);
    }
    const file = this.files.get(id);
    if (!file || file.trashed) return json({}, 404);
    if (method === 'PATCH') {
      Object.assign(file, data);
      if (url.searchParams.has('addParents')) file.parents = [url.searchParams.get('addParents')!];
      return json(fields(file));
    }
    if (url.searchParams.get('alt') === 'media') return new Response(new Uint8Array(file.body));
    return json(fields(file));
  }) as typeof fetch;
}
