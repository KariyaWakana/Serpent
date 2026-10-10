import { createHash, randomUUID } from 'node:crypto';

import type { GoogleDriveCredentials } from '../../shared/google-drive-sync';
import {
  RemoteStorageError,
  type DriverCapabilities, type RemoteEntry, type RemoteReadResult,
  type RemoteStorageDriver, type RemoteWriteOptions, type RemoteWriteResult,
} from './remote-storage';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,size,modifiedTime,parents,trashed';
const CHUNK = 8 * 1024 * 1024; // A multiple of Drive's 256 KiB chunk size.
interface TokenState { accessToken?: string; expiresAt: number; refreshing?: Promise<string> }
// Drivers are rebuilt on every poll. Reuse short-lived tokens without persisting
// them, bounded by account credentials so revoked/reconnected accounts do not mix.
const tokens = new Map<string, TokenState>();
interface DriveFile {
  id: string; name: string; mimeType: string; size?: string;
  modifiedTime?: string; parents?: string[]; trashed?: boolean;
}
const quote = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function parts(path: string): string[] {
  if (path === '' || path === '.') return [];
  // Existing sync callers occasionally join an already slash-terminated directory.
  if (path.startsWith('/') || path.includes('\\') || [...path].some((char) => char.charCodeAt(0) < 32)) {
    throw new RemoteStorageError('INVALID_URL', 'Google Drive: invalid relative path.');
  }
  const result = path.split('/').filter(Boolean);
  if (result.some((part) => part === '.' || part === '..')) {
    throw new RemoteStorageError('INVALID_URL', 'Google Drive: path traversal is not allowed.');
  }
  return result;
}

/** Drive v3 adapter. Folder IDs are authoritative; paths are resolved inside one root. */
export class GoogleDriveDriver implements RemoteStorageDriver {
  private readonly auth: TokenState;
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: GoogleDriveCredentials, options: { fetch?: typeof fetch } = {}) {
    this.fetcher = options.fetch ?? fetch;
    if (!config.clientId || !config.refreshToken || !config.folderId) {
      throw new RemoteStorageError('AUTH_FAILED', 'Google Drive: reconnect this account in sync settings.');
    }
    if (!/^[\w-]+$/.test(config.folderId)) throw new RemoteStorageError('INVALID_URL', 'Google Drive: enter a folder ID, not a URL.');
    const key = createHash('sha256').update(JSON.stringify([config.clientId, config.clientSecret, config.refreshToken])).digest('hex');
    this.auth = tokens.get(key) ?? { expiresAt: 0 };
    if (tokens.size >= 32 && !tokens.has(key)) tokens.delete(tokens.keys().next().value!);
    tokens.set(key, this.auth);
  }

  private async token(force = false): Promise<string> {
    if (!force && this.auth.accessToken && Date.now() < this.auth.expiresAt) return this.auth.accessToken;
    if (this.auth.refreshing) return this.auth.refreshing;
    this.auth.refreshing = (async () => {
      let response: Response;
      try {
        response = await this.fetcher('https://oauth2.googleapis.com/token', {
          method: 'POST', signal: AbortSignal.timeout(30_000),
          body: new URLSearchParams({
            client_id: this.config.clientId, refresh_token: this.config.refreshToken,
            grant_type: 'refresh_token',
            ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
          }),
        });
      } catch {
        throw new RemoteStorageError('NETWORK_ERROR', 'Google Drive: could not refresh the connection.', true);
      }
      if (!response.ok) {
        throw new RemoteStorageError(response.status >= 500 || response.status === 429 ? 'NETWORK_ERROR' : 'AUTH_FAILED',
          'Google Drive: could not refresh access. Reconnect the account if authorization expired.', response.status >= 500 || response.status === 429);
      }
      const result = await response.json() as { access_token?: string; expires_in?: number };
      if (!result.access_token) throw new RemoteStorageError('AUTH_FAILED', 'Google Drive: no access token returned.');
      this.auth.accessToken = result.access_token;
      this.auth.expiresAt = Date.now() + Math.max(0, (result.expires_in ?? 3600) - 60) * 1000;
      return result.access_token;
    })();
    try { return await this.auth.refreshing; } finally { this.auth.refreshing = undefined; }
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const send = async (token: string) => {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return this.fetcher(url, { ...init, headers, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(120_000) });
    };
    let response: Response;
    try {
      response = await send(await this.token());
      if (response.status === 401) response = await send(await this.token(true));
    } catch (error) {
      if (error instanceof RemoteStorageError) throw error;
      throw new RemoteStorageError('NETWORK_ERROR', 'Google Drive: network request failed.', true);
    }
    if (response.ok || response.status === 308) return response;
    let reason = '';
    try {
      const body = await response.json() as { error?: { errors?: { reason?: string }[] } };
      reason = body.error?.errors?.[0]?.reason ?? '';
    } catch { /* Do not expose remote response bodies, which may contain credentials. */ }
    const code = response.status === 401 ? 'AUTH_FAILED'
      : response.status === 404 ? 'NOT_FOUND'
        : response.status === 412 ? 'PRECONDITION_FAILED'
          : reason === 'storageQuotaExceeded' ? 'QUOTA_EXCEEDED'
            : response.status === 429 || ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason) ? 'LOCKED'
              : response.status === 403 ? 'PERMISSION_DENIED' : `HTTP_${response.status}`;
    throw new RemoteStorageError(code, `Google Drive request failed (${response.status}, ${code}).`,
      response.status >= 500 || code === 'LOCKED');
  }

  private async children(parent: string, name?: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        q: `'${quote(parent)}' in parents and trashed = false${name === undefined ? '' : ` and name = '${quote(name)}'`}`,
        fields: `nextPageToken,incompleteSearch,files(${FIELDS})`, pageSize: '1000', spaces: 'drive',
        ...(pageToken ? { pageToken } : {}),
      });
      const result = await (await this.request(`${API}/files?${query}`)).json() as {
        files?: DriveFile[]; nextPageToken?: string; incompleteSearch?: boolean;
      };
      if (result.incompleteSearch) throw new RemoteStorageError('CONFLICT', 'Google Drive returned an incomplete folder listing. Please retry.');
      files.push(...result.files ?? []);
      pageToken = result.nextPageToken;
    } while (pageToken);
    return files;
  }

  private async unique(parent: string, name: string): Promise<DriveFile | undefined> {
    const matches = await this.children(parent, name);
    if (matches.length > 1) throw new RemoteStorageError('CONFLICT', `Google Drive: multiple items named “${name}”. Resolve duplicates in Drive before syncing.`);
    return matches[0];
  }

  private async metadata(id: string): Promise<{ file: DriveFile; etag?: string }> {
    const response = await this.request(`${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}`);
    const file = await response.json() as DriveFile;
    if (file.trashed) throw new RemoteStorageError('NOT_FOUND', 'Google Drive: this item is in the trash.');
    return { file, etag: response.headers.get('etag') ?? undefined };
  }

  private async resolve(path: string, createDirectories = false): Promise<DriveFile | undefined> {
    let current: DriveFile = { id: this.config.folderId, name: '', mimeType: FOLDER };
    for (const segment of parts(path)) {
      if (current.mimeType !== FOLDER) throw new RemoteStorageError('CONFLICT', 'Google Drive: a file occupies a required folder path.');
      let next = await this.unique(current.id, segment);
      if (!next && createDirectories) {
        next = await (await this.request(`${API}/files?fields=${FIELDS}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: segment, mimeType: FOLDER, parents: [current.id] }),
        })).json() as DriveFile;
        // Drive has no unique-name constraint. Surface creation races explicitly.
        next = await this.unique(current.id, segment) ?? next;
      }
      if (!next) return undefined;
      current = next;
    }
    return current;
  }

  /** Discover only this OAuth app's marked roots; do not adopt arbitrary "Serpent" folders. */
  async ensureAppRoot(): Promise<string> {
    const query = new URLSearchParams({
      q: "'root' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='serpentSyncRoot' and value='1' }",
      fields: 'files(id),nextPageToken', pageSize: '1000', spaces: 'drive',
    });
    const found = await (await this.request(`${API}/files?${query}`)).json() as { files?: { id: string }[]; nextPageToken?: string };
    if ((found.files?.length ?? 0) > 1 || found.nextPageToken) throw new RemoteStorageError('CONFLICT', 'Google Drive: multiple Serpent roots. Enter the intended folder ID.');
    if (found.files?.[0]) return found.files[0].id;
    const created = await (await this.request(`${API}/files?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Serpent', mimeType: FOLDER, parents: ['root'], appProperties: { serpentSyncRoot: '1' } }),
    })).json() as { id: string };
    return created.id;
  }

  async probe(): Promise<DriverCapabilities> {
    const { file } = await this.metadata(this.config.folderId);
    if (file.mimeType !== FOLDER) throw new RemoteStorageError('CONFLICT', 'Google Drive root must be a folder.');
    await this.children(file.id);
    return { auth: 'oauth2', supportsContentTransfer: true, supportsDepthInfinity: true,
      supportsEtagIfMatch: false, supportsMove: true, supportsLock: false };
  }

  async list(path: string, depth: '0' | '1' | 'infinity' = '1'): Promise<RemoteEntry[]> {
    const file = await this.resolve(path);
    if (!file) throw new RemoteStorageError('NOT_FOUND', 'Google Drive: folder not found.');
    const prefix = parts(path).join('/');
    const entry = (value: DriveFile, itemPath: string): RemoteEntry => ({
      path: itemPath + (value.mimeType === FOLDER && itemPath ? '/' : ''), isDirectory: value.mimeType === FOLDER,
      ...(value.size === undefined ? {} : { size: Number(value.size) }), lastModified: value.modifiedTime,
    });
    const result = [entry(file, prefix)];
    const visit = async (folder: DriveFile, folderPath: string): Promise<void> => {
      const children = await this.children(folder.id);
      const names = new Set<string>();
      for (const child of children) {
        if (names.has(child.name) || parts(child.name).length !== 1 || child.name.includes('/')) {
          throw new RemoteStorageError('CONFLICT', 'Google Drive: duplicate or nonportable names in the sync folder.');
        }
        names.add(child.name);
        const childPath = folderPath ? `${folderPath}/${child.name}` : child.name;
        result.push(entry(child, childPath));
        if (depth === 'infinity' && child.mimeType === FOLDER) await visit(child, childPath);
      }
    };
    if (depth !== '0' && file.mimeType === FOLDER) await visit(file, prefix);
    return result;
  }

  async read(path: string): Promise<RemoteReadResult> {
    const file = await this.resolve(path);
    if (!file) throw new RemoteStorageError('NOT_FOUND', 'Google Drive: file not found.');
    if (file.mimeType.startsWith('application/vnd.google-apps.')) throw new RemoteStorageError('CONFLICT', 'Google Drive: expected an asset file, not a Google document or folder.');
    const response = await this.request(`${API}/files/${encodeURIComponent(file.id)}?alt=media`);
    return { body: Buffer.from(await response.arrayBuffer()), lastModified: file.modifiedTime };
  }

  async mkdir(path: string): Promise<void> {
    const file = await this.resolve(path, true);
    if (file?.mimeType !== FOLDER) throw new RemoteStorageError('CONFLICT', 'Google Drive: expected a folder.');
  }

  async exists(path: string): Promise<boolean> { return (await this.resolve(path)) !== undefined; }

  async write(path: string, body: Buffer, options: RemoteWriteOptions = {}): Promise<RemoteWriteResult> {
    if (options.ifMatch) throw new RemoteStorageError('PRECONDITION_FAILED', 'Google Drive cannot apply a WebDAV version token. Use a fresh local library for this provider.');
    const segments = parts(path);
    const name = segments.pop();
    if (!name) throw new RemoteStorageError('CONFLICT', 'Google Drive: cannot overwrite the sync root.');
    const parent = await this.resolve(segments.join('/'), true);
    if (!parent || parent.mimeType !== FOLDER) throw new RemoteStorageError('CONFLICT', 'Google Drive: invalid parent folder.');
    const existing = await this.unique(parent.id, name);
    if (existing?.mimeType === FOLDER || (existing && options.overwrite === false)) throw new RemoteStorageError('CONFLICT', 'Google Drive: destination already exists.');
    // Drive v3 does not expose a documented conditional-write guarantee. Never
    // silently pretend to enforce WebDAV ETags (including after switching providers).
    const endpoint = existing ? `${UPLOAD}/files/${encodeURIComponent(existing.id)}` : `${UPLOAD}/files`;
    const metadata = existing ? {} : { name, parents: [parent.id] };
    let response: Response;
    if (body.length <= 5 * 1024 * 1024) {
      const boundary = `serpent-${randomUUID()}`;
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
        body, Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      response = await this.request(`${endpoint}?uploadType=multipart&fields=id`, {
        method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: new Uint8Array(payload),
      });
    } else {
      const start = await this.request(`${endpoint}?uploadType=resumable&fields=id`, {
        method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(body.length) },
        body: JSON.stringify(metadata),
      });
      const location = start.headers.get('location');
      // Never forward a bearer token to an arbitrary Location supplied by a server.
      if (!location || new URL(location).origin !== 'https://www.googleapis.com' || !new URL(location).pathname.startsWith('/upload/drive/')) {
        throw new RemoteStorageError('PERMISSION_DENIED', 'Google Drive returned an invalid upload session.');
      }
      let offset = 0;
      let attempts = 0;
      response = start;
      while (offset < body.length) {
        const end = Math.min(offset + CHUNK, body.length);
        try {
          response = await this.request(location, {
            method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${offset}-${end - 1}/${body.length}` },
            body: new Uint8Array(body.subarray(offset, end)),
          });
        } catch (error) {
          if (!(error instanceof RemoteStorageError) || !error.retryable || ++attempts > 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, attempts * 500));
          response = await this.request(location, { method: 'PUT', headers: { 'Content-Range': `bytes */${body.length}` }, body: new Uint8Array() });
        }
        if (response.status !== 308) break;
        const range = response.headers.get('range');
        const next = range ? Number(/^bytes=0-(\d+)$/.exec(range)?.[1]) + 1 : 0;
        if (!Number.isSafeInteger(next) || next < 0 || next > body.length || next % (256 * 1024) !== 0) throw new RemoteStorageError('CONFLICT', 'Google Drive returned an invalid upload offset.');
        if (next <= offset && ++attempts > 3) throw new RemoteStorageError('NETWORK_ERROR', 'Google Drive upload made no progress.', true);
        offset = next;
      }
      if (response.status === 308) throw new RemoteStorageError('NETWORK_ERROR', 'Google Drive did not finish the upload.', true);
    }
    await this.unique(parent.id, name);
    return { status: response.status };
  }

  async delete(path: string): Promise<void> {
    if (!parts(path).length) throw new RemoteStorageError('PERMISSION_DENIED', 'Cannot delete the Google Drive sync root.');
    const file = await this.resolve(path);
    if (!file) return;
    // Keep recoverable assets in Drive trash rather than permanently deleting them.
    await this.request(`${API}/files/${encodeURIComponent(file.id)}?fields=id`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }),
    });
  }

  async move(from: string, to: string): Promise<void> {
    if (!parts(from).length || !parts(to).length) throw new RemoteStorageError('PERMISSION_DENIED', 'Cannot move the Google Drive sync root.');
    if (parts(to).join('/').startsWith(`${parts(from).join('/')}/`)) throw new RemoteStorageError('CONFLICT', 'Cannot move a folder inside itself.');
    if (parts(from).join('/') === parts(to).join('/')) return;
    const file = await this.resolve(from);
    if (!file) throw new RemoteStorageError('NOT_FOUND', 'Google Drive: source file not found.');
    const segments = parts(to);
    const name = segments.pop()!;
    const parent = await this.resolve(segments.join('/'), true);
    if (!parent || parent.mimeType !== FOLDER || await this.unique(parent.id, name)) throw new RemoteStorageError('CONFLICT', 'Google Drive: move destination already exists.');
    const old = (await this.metadata(file.id)).file;
    const query = new URLSearchParams({ fields: 'id', ...(old.parents?.includes(parent.id) ? {} : {
      addParents: parent.id, ...(old.parents?.length ? { removeParents: old.parents.join(',') } : {}),
    }) });
    await this.request(`${API}/files/${encodeURIComponent(file.id)}?${query}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    await this.unique(parent.id, name);
  }
}
