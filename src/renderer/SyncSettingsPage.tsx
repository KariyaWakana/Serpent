import { useEffect, useState, type ReactNode } from "react";

import type { SyncCapabilities } from "../shared/library-api";
import type { SyncServerInput } from "../shared/google-drive-sync";
import { Icon } from "./Icons";
import { iconActionAttrs } from "./icon-action-attrs";
import { useT } from "./i18n";
import { SettingsCard } from "./ui/patterns";
import { Switch } from "./ui/primitives";
import type { SyncServerSummary } from "./sync-settings-types";

export interface SyncServerSettingsCallbacks {
  syncListServers(): Promise<{ ok: true; value: SyncServerSummary[] } | { ok: false; message: string }>;
  syncSaveServer(input: SyncServerInput): Promise<{ ok: true; value: { id: string } } | { ok: false; message: string }>;
  syncDeleteServer(input: { id: string }): Promise<{ ok: true } | { ok: false; message: string }>;
  syncProbe(input: { serverId: string }): Promise<{ ok: true; value: SyncCapabilities } | { ok: false; message: string }>;
}

type BusyState = "save" | "delete" | null;

type ServerConnectionState = "checking" | "connected" | "failed";

interface ServerConnection {
  state: ServerConnectionState;
  message?: string;
}

function ConnectionDot({ state }: { state: ServerConnectionState | "idle" }): ReactNode {
  return <span className="sync-status-dot" data-state={state} />;
}

/**
 * Global sync-server management (Serpent-xffq). Servers configured here are
 * available to every library; each library selects a server + subpath in
 * LibrarySettings. Passwords are persisted encrypted in the Main process
 * (safeStorage) and never sent back to the renderer in full.
 */
export function SyncSettingsPage({
  callbacks,
  showCardSyncStatus,
  onShowCardSyncStatusChange,
}: {
  callbacks: SyncServerSettingsCallbacks;
  showCardSyncStatus: boolean;
  onShowCardSyncStatusChange: (checked: boolean) => void;
}): ReactNode {
  const t = useT();
  const [servers, setServers] = useState<SyncServerSummary[]>([]);
  const [connections, setConnections] = useState<Record<string, ServerConnection>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [provider, setProvider] = useState<"webdav" | "google-drive">("webdav");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [folderId, setFolderId] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [allowInsecureTls, setAllowInsecureTls] = useState(false);
  const [busy, setBusy] = useState<BusyState>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const probeServer = async (serverId: string) => {
    setConnections((current) => ({ ...current, [serverId]: { state: "checking" } }));
    const probe = await callbacks.syncProbe({ serverId });
    if (!probe.ok) {
      setConnections((current) => ({ ...current, [serverId]: { state: "failed", message: probe.message } }));
      return;
    }
    if (!probe.value.supportsContentTransfer) {
      setConnections((current) => ({
        ...current,
        [serverId]: { state: "failed", message: t("settings.sync.contentTransferUnsupported") },
      }));
      return;
    }
    setConnections((current) => ({ ...current, [serverId]: { state: "connected" } }));
  };

  const reload = async () => {
    const listed = await callbacks.syncListServers();
    if (listed.ok) {
      setServers(listed.value);
      for (const server of listed.value) {
        void probeServer(server.id);
      }
    }
  };

  useEffect(() => {
    void (async () => {
      const listed = await callbacks.syncListServers();
      if (!listed.ok) return;
      setServers(listed.value);
      for (const server of listed.value) {
        void probeServer(server.id);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetForm = () => {
    setEditingId(null);
    setProvider("webdav");
    setClientId("");
    setClientSecret("");
    setFolderId("");
    setBaseUrl("");
    setUsername("");
    setPassword("");
    setAllowInsecureTls(false);
    setError(null);
    setNotice(null);
  };

  const startEdit = (server: SyncServerSummary) => {
    setEditingId(server.id);
    setProvider(server.googleDrive ? "google-drive" : "webdav");
    setClientId(server.googleDrive?.clientId ?? "");
    setClientSecret("");
    setFolderId(server.googleDrive?.folderId ?? "");
    setBaseUrl(server.baseUrl);
    setUsername(server.username ?? "");
    setPassword("");
    setAllowInsecureTls(server.allowInsecureTls);
    setError(null);
    setNotice(null);
  };

  const saveServer = async () => {
    const url = provider === "google-drive" ? "https://drive.google.com" : baseUrl.trim();
    if (!url) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const saved = await callbacks.syncSaveServer({
        id: editingId ?? undefined,
        baseUrl: url,
        ...(provider === "google-drive" ? { googleDrive: {
          clientId: clientId.trim(), clientSecret: clientSecret.trim() || undefined,
          folderId: folderId.trim() || undefined,
        } } : {}),
        username: username.trim() || undefined,
        password: password || undefined,
        allowInsecureTls: allowInsecureTls || undefined,
      });
      if (!saved.ok) {
        setError(provider === "google-drive" ? t("settings.sync.googleError") : saved.message);
        return;
      }
      resetForm();
      setNotice(t("settings.sync.saved"));
      await reload();
      void probeServer(saved.value.id);
    } catch {
      setError(t("settings.sync.googleError"));
    } finally {
      setBusy(null);
    }
  };

  const deleteServer = async (serverId: string) => {
    if (confirmingDeleteId !== serverId) {
      setConfirmingDeleteId(serverId);
      return;
    }
    setBusy("delete");
    setError(null);
    setNotice(null);
    try {
      const deleted = await callbacks.syncDeleteServer({ id: serverId });
      if (!deleted.ok) {
        setError(deleted.message);
        return;
      }
      setNotice(t("settings.sync.deleted"));
      setConfirmingDeleteId(null);
      await reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsCard className="library-sync-card">
      <label className="app-settings-toggle-row">
        <span className="app-settings-row-copy">
          <strong>{t("settings.sync.showCardStatus")}</strong>
          <span>{t("settings.sync.showCardStatusHint")}</span>
        </span>
        <Switch
          aria-label={t("settings.sync.showCardStatus")}
          checked={showCardSyncStatus}
          onCheckedChange={onShowCardSyncStatusChange}
        />
      </label>
      <div className="app-settings-card-divider" />
      <div className="app-settings-row-copy">
        <strong>{t("settings.sync.serversTitle")}</strong>
        <span>{t("settings.sync.serversHint")}</span>
      </div>

      {servers.length === 0 ? (
        <p className="app-settings-help-note">{t("settings.sync.noServers")}</p>
      ) : (
        servers.map((server, index) => {
          const connection = connections[server.id];
          const state = connection?.state ?? "idle";
          const label = state === "checking"
            ? t("settings.sync.connectionChecking")
            : state === "connected"
              ? t("settings.sync.connectionConnected")
              : state === "failed"
                ? t("settings.sync.connectionFailed")
                : t("settings.sync.connectionUnknown");
          return (
            <div key={server.id}>
              {index > 0 ? <div className="app-settings-card-divider" /> : null}
              <div className="app-settings-action-row">
                <div className="app-settings-row-copy">
                  <strong>{server.googleDrive ? `Google Drive · ${server.googleDrive.folderId}` : server.baseUrl}</strong>
                  <span>
                    {server.googleDrive ? t("settings.sync.googleConnected") : server.username
                      ? t("settings.sync.serverSummary", {
                          username: server.username,
                          password: server.hasPassword ? t("settings.sync.passwordStored") : t("settings.sync.passwordNone"),
                        })
                      : t("settings.sync.serverSummaryAnonymous", {
                          password: server.hasPassword ? t("settings.sync.passwordStored") : t("settings.sync.passwordNone"),
                        })}
                    {state === "failed" && connection?.message ? ` · ${connection.message}` : ""}
                  </span>
                </div>
                <div className="app-settings-option-group">
                  <span className="sync-status-indicator" data-state={state}>
                    <ConnectionDot state={state} />
                    <span>{label}</span>
                  </span>
                  <button className="secondary-button" disabled={busy !== null} onClick={() => startEdit(server)} type="button">
                    {t("settings.sync.edit")}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy !== null}
                    onClick={() => void deleteServer(server.id)}
                    type="button"
                  >
                    {confirmingDeleteId === server.id ? t("settings.sync.deleteConfirm") : t("settings.sync.delete")}
                  </button>
                </div>
              </div>
            </div>
          );
        })
      )}

      <div className="app-settings-card-divider" />
      <div className="app-settings-row-copy">
        <strong>{editingId ? t("settings.sync.editServer") : t("settings.sync.addServer")}</strong>
      </div>
      <div className="app-settings-row app-settings-row-stack">
        <label htmlFor="sync-provider">{t("settings.sync.provider")}</label>
        <select id="sync-provider" className="text-field" disabled={busy !== null || editingId !== null} value={provider} onChange={(event) => setProvider(event.target.value as "webdav" | "google-drive")}>
          <option value="webdav">WebDAV</option>
          <option value="google-drive">Google Drive</option>
        </select>
      </div>
      {provider === "google-drive" ? <>
        <p className="app-settings-help-note">{t("settings.sync.googleSetupHint")}</p>
        <div className="app-settings-row app-settings-row-stack">
          <label htmlFor="google-client-id">{t("settings.sync.googleClientId")}</label>
          <input id="google-client-id" className="text-field" value={clientId} disabled={busy !== null || editingId !== null} onChange={(event) => setClientId(event.target.value)} placeholder="…apps.googleusercontent.com" />
          <label htmlFor="google-client-secret">{t("settings.sync.googleClientSecret")}</label>
          <input id="google-client-secret" className="text-field" type="password" autoComplete="off" value={clientSecret} disabled={busy !== null} onChange={(event) => setClientSecret(event.target.value)} />
          <label htmlFor="google-folder-id">{t("settings.sync.googleFolderId")}</label>
          <input id="google-folder-id" className="text-field" value={folderId} disabled={busy !== null || editingId !== null} onChange={(event) => setFolderId(event.target.value)} />
          <span className="app-settings-help-note">{t("settings.sync.googleFolderHint")}</span>
        </div>
        <p className="app-settings-help-note">{t("settings.sync.googleConcurrencyHint")}</p>
      </> : <>
      <div className="app-settings-row app-settings-row-stack">
        <div className="app-settings-row-copy">
          <strong>{t("settings.sync.webdavUrl")}</strong>
          <span>{t("settings.sync.webdavUrlHint")}</span>
        </div>
        <input className="text-field" aria-label={t("settings.sync.webdavUrl")} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://nas.local/dav/share/" />
      </div>
      <div className="app-settings-row app-settings-row-stack">
        <div className="app-settings-row-copy">
          <strong>{t("settings.sync.credentials")}</strong>
          <span>{t("settings.sync.credentialsHint")}</span>
        </div>
        <div className="library-settings-name-row">
          <input className="text-field" aria-label={t("settings.sync.username")} value={username} onChange={(event) => setUsername(event.target.value)} placeholder={t("settings.sync.username")} />
          <div className="field-with-visibility-toggle">
            <input className="text-field field-with-visibility-input" aria-label={t("settings.sync.password")} type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={editingId ? t("settings.sync.passwordKeepHint") : t("settings.sync.password")} />
            <button
              className="visibility-toggle"
              onClick={() => setShowPassword((prev) => !prev)}
              type="button"
              {...iconActionAttrs(
                showPassword ? t("settings.sync.hidePassword") : t("settings.sync.showPassword"),
              )}
            >
              <Icon name={showPassword ? "eye-off" : "eye"} size={14} />
            </button>
          </div>
        </div>
      </div>
      <div className="app-settings-row">
        <div className="app-settings-row-copy">
          <strong>{t("settings.sync.insecureTls")}</strong>
          <span>{t("settings.sync.insecureTlsHint")}</span>
        </div>
        <input type="checkbox" checked={allowInsecureTls} onChange={(event) => setAllowInsecureTls(event.target.checked)} />
      </div>
      </>}
      {error ? <p className="settings-error-message">{error}</p> : null}
      {notice ? <p className="settings-success-message">{notice}</p> : null}
      <div className="app-settings-action-row">
        <span className="app-settings-row-copy" />
        <div className="app-settings-option-group">
          {editingId ? (
            <button className="secondary-button" disabled={busy !== null} onClick={resetForm} type="button">
              {t("common.cancel")}
            </button>
          ) : null}
          <button className="primary-button" disabled={busy !== null || (provider === "google-drive" ? !clientId.trim() : !baseUrl.trim())} onClick={() => void saveServer()} type="button">
            {busy === "save" ? (provider === "google-drive" ? t("settings.sync.googleConnecting") : t("common.saving")) : (provider === "google-drive" ? t("settings.sync.googleConnect") : t("common.save"))}
          </button>
        </div>
      </div>
    </SettingsCard>
  );
}
