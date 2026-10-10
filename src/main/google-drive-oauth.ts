import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

import type { GoogleDriveSetup } from '../shared/google-drive-sync';

export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** System-browser installed-app flow: random loopback port, state and S256 PKCE. */
export async function authorizeGoogleDrive(
  setup: GoogleDriveSetup,
  openExternal: (url: string) => Promise<unknown>,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ refreshToken: string; clientSecret?: string }> {
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(setup.clientId)) {
    throw new Error('Google Drive: enter a Desktop OAuth client ID.');
  }
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  let redirectUri = '';
  let settled = false;
  let complete: (code: string) => void;
  let fail: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  // Opening the browser can fail before the promise is awaited.
  void codePromise.catch(() => undefined);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', redirectUri);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' || url.pathname !== '/oauth2callback' || url.searchParams.get('state') !== state || settled) {
      res.writeHead(400).end('Invalid authorization response.');
      return;
    }
    settled = true;
    const code = url.searchParams.get('code');
    if (url.searchParams.has('error') || !code) {
      res.end('Authorization cancelled. Return to Serpent.');
      fail(new Error('Google Drive authorization was cancelled.'));
    } else {
      res.end('Authorization received. You can close this tab and return to Serpent.');
      complete(code);
    }
  });
  const timer = setTimeout(() => fail(new Error('Google Drive authorization timed out. Please try again.')), options.timeoutMs ?? 180_000);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not start OAuth callback.');
    redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: setup.clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: GOOGLE_DRIVE_SCOPE, state, access_type: 'offline', prompt: 'consent',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    await openExternal(url.toString());
    const code = await codePromise;
    const response = await (options.fetch ?? fetch)('https://oauth2.googleapis.com/token', {
      method: 'POST', signal: AbortSignal.timeout(30_000),
      body: new URLSearchParams({
        client_id: setup.clientId, ...(setup.clientSecret ? { client_secret: setup.clientSecret } : {}),
        grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri,
      }),
    });
    // Never copy token endpoint bodies to errors/logs.
    if (!response.ok) throw new Error(`Google Drive token exchange failed (${response.status}). Check the Desktop OAuth client settings.`);
    const tokens = await response.json() as { refresh_token?: string; scope?: string };
    if (!tokens.refresh_token || (tokens.scope && !tokens.scope.split(' ').includes(GOOGLE_DRIVE_SCOPE))) {
      throw new Error('Google Drive did not grant offline file access. Please authorize again.');
    }
    return { refreshToken: tokens.refresh_token, clientSecret: setup.clientSecret };
  } finally {
    settled = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}
