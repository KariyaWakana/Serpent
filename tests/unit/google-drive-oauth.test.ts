import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';

import { authorizeGoogleDrive, GOOGLE_DRIVE_SCOPE } from '../../src/main/google-drive-oauth';

const clientId = 'test.apps.googleusercontent.com';

it('uses the system browser, loopback, exact state and S256 PKCE; only Main gets refresh credentials', async () => {
  let authorization: URL;
  let redirectUri = '';
  const exchange = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const form = init?.body as URLSearchParams;
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('client_secret')).toBe('desktop-secret');
    expect(form.get('redirect_uri')).toBe(redirectUri);
    const challenge = createHash('sha256').update(form.get('code_verifier')!).digest('base64url');
    expect(challenge).toBe(authorization.searchParams.get('code_challenge'));
    return new Response(JSON.stringify({ refresh_token: 'offline-token', scope: GOOGLE_DRIVE_SCOPE }));
  });
  const result = await authorizeGoogleDrive({ clientId, clientSecret: 'desktop-secret' }, async (url) => {
    authorization = new URL(url);
    expect(authorization.origin).toBe('https://accounts.google.com');
    expect(authorization.searchParams.get('scope')).toBe(GOOGLE_DRIVE_SCOPE);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    redirectUri = authorization.searchParams.get('redirect_uri')!;
    expect(new URL(redirectUri).hostname).toBe('127.0.0.1');
    const callback = new URL(redirectUri);
    callback.searchParams.set('code', 'code'); callback.searchParams.set('state', 'wrong-state');
    expect((await fetch(callback)).status).toBe(400);
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    expect((await fetch(callback)).status).toBe(200);
  }, { fetch: exchange });
  expect(result).toEqual({ refreshToken: 'offline-token', clientSecret: 'desktop-secret' });
  expect(exchange).toHaveBeenCalledOnce();
  await expect(fetch(redirectUri)).rejects.toThrow(); // Listener is closed after completion.
});

it('handles denied consent without exchanging tokens', async () => {
  const exchange = vi.fn();
  await expect(authorizeGoogleDrive({ clientId }, async (url) => {
    const authorization = new URL(url);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, error: 'access_denied' }).toString();
    await fetch(callback);
  }, { fetch: exchange })).rejects.toThrow('cancelled');
  expect(exchange).not.toHaveBeenCalled();
});

it('closes the listener on timeout or browser launch failure', async () => {
  let callback = '';
  await expect(authorizeGoogleDrive({ clientId }, async (url) => {
    callback = new URL(url).searchParams.get('redirect_uri')!;
  }, { timeoutMs: 20 })).rejects.toThrow('timed out');
  await expect(fetch(callback)).rejects.toThrow();
  await expect(authorizeGoogleDrive({ clientId }, async () => { throw new Error('browser unavailable'); })).rejects.toThrow('browser unavailable');
});

it('does not expose token response bodies in errors', async () => {
  const tokenFetch: typeof fetch = async () => new Response('PRIVATE-TOKEN-MUST-NOT-LEAK', { status: 400 });
  await expect(authorizeGoogleDrive({ clientId }, async (url) => {
    const auth = new URL(url);
    const callback = new URL(auth.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({ state: auth.searchParams.get('state')!, code: 'code' }).toString();
    await fetch(callback);
  }, { fetch: tokenFetch })).rejects.toThrow('token exchange failed (400)');
});
