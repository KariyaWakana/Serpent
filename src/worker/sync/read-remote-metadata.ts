import type { SyncManifestEntry } from './manifest';
import { RemoteStorageError, type RemoteStorageDriver } from './remote-storage';
import { metadataContentHash, parseSyncAssetMetadata, type SyncAssetMetadata } from './sync-metadata';

/** Only legacy entries without an advertised sidecar may omit metadata in strict mode. */
export async function readRemoteMetadata(
  driver: RemoteStorageDriver,
  path: string,
  entry: SyncManifestEntry,
  strict: boolean,
): Promise<SyncAssetMetadata | undefined> {
  try {
    const read = await driver.read(path);
    const metadata = parseSyncAssetMetadata(read.body.toString('utf-8'));
    if (strict && entry.metadataHash !== undefined && metadataContentHash(metadata) !== entry.metadataHash) {
      throw new RemoteStorageError('CONFLICT', 'Remote metadata does not match the sync manifest. Retry after the other device finishes syncing.');
    }
    return metadata;
  } catch (error) {
    if (strict && (!(error instanceof RemoteStorageError) || error.code !== 'NOT_FOUND' || entry.metadataHash !== undefined)) throw error;
    return undefined;
  }
}
