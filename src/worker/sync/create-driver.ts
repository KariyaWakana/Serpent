import type { GoogleDriveCredentials } from '../../shared/google-drive-sync';
import { normalizeWebDAVBaseUrl } from '../../shared/sync-paths';
import { GoogleDriveDriver } from './google-drive-driver';
import { RemoteStorageError, type RemoteStorageDriver } from './remote-storage';
import { WebDAVDriver } from './webdav-driver';

export interface SyncDriverConfig {
  baseUrl: string; username?: string; password?: string; allowInsecureTls?: boolean;
  googleDrive?: GoogleDriveCredentials;
}

export function createSyncDriver(config: SyncDriverConfig): RemoteStorageDriver {
  if (config.googleDrive) return new GoogleDriveDriver(config.googleDrive);
  const normalized = normalizeWebDAVBaseUrl(config.baseUrl);
  if (!normalized.ok) throw new RemoteStorageError('INVALID_URL', normalized.error);
  return new WebDAVDriver({ ...config, baseUrl: normalized.value });
}
