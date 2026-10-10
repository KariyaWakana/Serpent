import type { ParentPort } from 'electron';

import {
  SYNC_ASSETS_DIR,
  SYNC_MANIFEST_FILE,
  SYNC_METADATA_DIR,
  sanitizeSyncDirectoryName,
} from '../../shared/sync-paths';
import type { WorkerRequest } from '../../shared/protocol/requests';
import type { WorkerResult } from '../../shared/protocol/responses';
import type { LibraryService } from '../library-service';
import { parseManifest, serializeManifest } from '../sync/manifest';
import { createLibrarySyncPort } from '../sync/library-port';
import { parseSyncAssetMetadata } from '../sync/sync-metadata';
import { SyncEngine, type SyncEngineOptions } from '../sync/sync-engine';
import { createSyncDriver } from '../sync/create-driver';
import { RemoteStorageError } from '../sync/remote-storage';

function buildSyncEngine(
  libraryService: LibraryService,
  deviceId: string,
  onProgress?: SyncEngineOptions['onProgress'],
): SyncEngine {
  return new SyncEngine(createLibrarySyncPort(libraryService), { deviceId, onProgress });
}


export async function executeSyncWorkerCommand(
  libraryService: LibraryService,
  parentPort: ParentPort | undefined,
  request: WorkerRequest,
): Promise<WorkerResult | undefined> {
  switch (request.command.type) {
    case 'sync.probe': {
      // Serpent-xffq：连接级能力探测（不触碰库）。
      const driver = createSyncDriver({
        googleDrive: request.command.googleDrive,
        baseUrl: request.command.baseUrl,
        username: request.command.username,
        password: request.command.password,
        allowInsecureTls: request.command.allowInsecureTls,
      });
      const capabilities = await driver.probe();
      return { ok: true, type: 'sync.probed', capabilities };
    }
    case 'sync.preview': {
      const engine = buildSyncEngine(libraryService, request.command.deviceId);
      const report = await engine.previewSync(request.command.libraryId, {
        id: 'request',
        googleDrive: request.command.googleDrive,
        baseUrl: request.command.baseUrl,
        username: request.command.username,
        password: request.command.password,
        allowInsecureTls: request.command.allowInsecureTls,
        directoryName: request.command.directoryName,
      });
      return { ok: true, type: 'sync.previewed', report };
    }
    case 'sync.run': {
      const libraryId = request.command.libraryId;
      const engine = buildSyncEngine(libraryService, request.command.deviceId, (done, total, bytesDone, bytesTotal) => {
        if (parentPort) {
          parentPort.postMessage({
            type: 'sync.progress',
            libraryId,
            phase: 'run',
            filesDone: done,
            filesTotal: total,
            bytesDone,
            bytesTotal,
          });
        }
      });
      const sessionId = libraryService.beginSyncSession(libraryId);
      try {
        const outcome = await engine.syncOnce(libraryId, {
          id: 'request',
          googleDrive: request.command.googleDrive,
          baseUrl: request.command.baseUrl,
          username: request.command.username,
          password: request.command.password,
          allowInsecureTls: request.command.allowInsecureTls,
          directoryName: request.command.directoryName,
        });
        libraryService.finishSyncSession(libraryId, sessionId, 'done');
        if (parentPort) {
          parentPort.postMessage({
            type: 'sync.progress',
            libraryId,
            phase: 'complete',
            filesDone: 0,
            filesTotal: 0,
            bytesDone: 0,
            bytesTotal: 0,
          });
        }
        return { ok: true, type: 'sync.completed', report: outcome.report, conflicts: outcome.conflicts };
      } catch (error) {
        libraryService.finishSyncSession(
          libraryId,
          sessionId,
          'failed',
          error instanceof Error ? error.message : String(error),
        );
        if (parentPort) {
          parentPort.postMessage({
            type: 'sync.progress',
            libraryId,
            phase: 'complete',
            filesDone: 0,
            filesTotal: 0,
            bytesDone: 0,
            bytesTotal: 0,
          });
        }
        throw error;
      }
    }
    case 'sync.poll-remote': {
      // 自动同步轮询（Serpent-bfsb 后续）：轻量检测远端 manifest 变化，
      // 不做本地全量 hash，供 Main 定时调度器决定是否触发完整同步。
      // Serpent-140fe2/308675: pollRemoteChange 先打一轮 WebDAV 网络请求、
      // 之后才读本地缓存（需要库已打开）。对未打开的库必须快速跳过——
      // 否则每个轮询周期都用一次网络往返占用单线程 Worker，交互命令
      // （翻页/缩略图路径解析）在其后排队，表现为数秒级浏览卡顿。
      if (!libraryService.isLibraryOpen(request.command.libraryId)) {
        return {
          ok: true,
          type: 'sync.poll-remote.result',
          changed: false,
        };
      }
      const engine = buildSyncEngine(libraryService, request.command.deviceId);
      const changed = await engine.pollRemoteChange(request.command.libraryId, {
        id: 'request',
        googleDrive: request.command.googleDrive,
        baseUrl: request.command.baseUrl,
        username: request.command.username,
        password: request.command.password,
        allowInsecureTls: request.command.allowInsecureTls,
        directoryName: request.command.directoryName,
      });
      return { ok: true, type: 'sync.poll-remote.result', changed };
    }
    case 'sync.asset-card-status': {
      if (!libraryService.isLibraryOpen(request.command.libraryId)) {
        return { ok: true, type: 'sync.asset-card-status', statuses: [] };
      }
      return {
        ok: true,
        type: 'sync.asset-card-status',
        statuses: libraryService.listSyncCardStatuses(
          request.command.libraryId,
          request.command.assetIds,
        ),
      };
    }
    case 'sync.list-remote-libraries': {
      const driver = createSyncDriver({
        googleDrive: request.command.googleDrive,
        baseUrl: request.command.baseUrl,
        username: request.command.username,
        password: request.command.password,
        allowInsecureTls: request.command.allowInsecureTls,
      });
      const entries = await driver.list('', '1');
      const libraries: Array<{ libraryId: string; displayName: string; directoryName: string }> = [];
      for (const entry of entries) {
        // 跳过根目录条目（path 为空）与非目录。
        if (!entry.isDirectory || entry.path === '') continue;
        try {
          const read = await driver.read(`${entry.path}/${SYNC_MANIFEST_FILE}`);
          const manifest = parseManifest(read.body.toString('utf-8'));
          libraries.push({
            libraryId: manifest.libraryId,
            displayName: manifest.displayName,
            directoryName: manifest.directoryName,
          });
        } catch (error) {
          if (request.command.googleDrive && error instanceof RemoteStorageError && error.code !== 'NOT_FOUND') throw error;
          // 无有效 manifest 的目录不是同步库，跳过。
        }
      }
      return { ok: true, type: 'sync.remote-libraries', remoteLibraries: libraries };
    }
    case 'sync.open-remote-library': {
      const driver = createSyncDriver({
        googleDrive: request.command.googleDrive,
        baseUrl: request.command.baseUrl,
        username: request.command.username,
        password: request.command.password,
        allowInsecureTls: request.command.allowInsecureTls,
      });
      const directoryName = sanitizeSyncDirectoryName(
        request.command.directoryName || request.command.displayName,
        request.command.libraryId,
      );
      const manifest = parseManifest(
        (await driver.read(`${directoryName}/${SYNC_MANIFEST_FILE}`)).body.toString('utf-8'),
      );
      const identityLibraryId = manifest.libraryId || request.command.libraryId;
      const identityDisplayName = manifest.displayName || request.command.displayName;
      const created = libraryService.createLibrary({
        displayName: identityDisplayName,
        selectedParentPath: request.command.selectedParentPath,
        libraryId: identityLibraryId,
      });
      try {
        for (const [syncId, entry] of Object.entries(manifest.entries)) {
          const read = await driver.read(`${directoryName}/${SYNC_ASSETS_DIR}/${entry.path}`);
          libraryService.applySyncContentUpdate(created.libraryId, syncId, entry.path, read.body);
          try {
            const sidecar = await driver.read(`${directoryName}/${SYNC_METADATA_DIR}/${syncId}.json`);
            libraryService.applySyncAssetMetadata(
              created.libraryId,
              syncId,
              parseSyncAssetMetadata(sidecar.body.toString('utf-8')),
            );
          } catch (error) {
            if (request.command.googleDrive && (!(error instanceof RemoteStorageError) || error.code !== 'NOT_FOUND')) throw error;
            // 无 sidecar：只落媒体。
          }
        }
      } catch (error) {
        // 下载失败：关闭已创建的库并向上抛，用户可删除部分库后重试。
        try {
          libraryService.closeLibrary(created.libraryId);
        } catch {
          // 关闭失败不掩盖原始错误。
        }
        throw error;
      }
      libraryService.writeSyncManifestCache(created.libraryId, serializeManifest(manifest));
      return { ok: true, type: 'library.opened', library: created };
    }
    default:
      return undefined;
  }
}
