/** Main-to-worker credentials. Never include this object in renderer responses. */
export interface GoogleDriveCredentials {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  folderId: string;
}

export interface GoogleDriveSetup {
  clientId: string;
  clientSecret?: string;
  /** Blank on the first device; use the saved ID on the second device. */
  folderId?: string;
}

export interface SyncServerInput {
  id?: string;
  baseUrl: string;
  username?: string;
  password?: string;
  allowInsecureTls?: boolean;
  googleDrive?: GoogleDriveSetup;
}

export interface SyncServerSummary {
  id: string;
  baseUrl: string;
  username?: string;
  hasPassword: boolean;
  allowInsecureTls: boolean;
  googleDrive?: { clientId: string; folderId: string };
}
