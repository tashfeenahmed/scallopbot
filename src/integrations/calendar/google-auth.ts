/**
 * `scallopbot google-auth`: installed-app OAuth (loopback redirect + PKCE)
 * that prints a refresh token for GOOGLE_REFRESH_TOKEN.
 *
 * Works on a headless box too: open the printed URL on any machine, and if
 * the browser cannot reach the loopback address, paste the URL it ended up on.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as readline from 'node:readline';
import { GOOGLE_AUTH_URL, GOOGLE_CALENDAR_SCOPE, GOOGLE_TOKEN_URL } from './google.js';
import type { FetchLike } from './ics.js';

export interface GoogleAuthOptions {
  clientId: string;
  clientSecret: string;
  scope?: string;
  port?: number;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export function buildAuthUrl(params: { clientId: string; redirectUri: string; scope: string; state: string; challenge: string }): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', params.scope);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Pull `code` out of a redirect URL, checking `state`. */
export function codeFromRedirect(redirect: string, expectedState: string): string {
  const url = new URL(redirect.trim(), 'http://127.0.0.1');
  const error = url.searchParams.get('error');
  if (error) throw new Error(`Google returned an error: ${error}`);
  if (url.searchParams.get('state') !== expectedState) throw new Error('State mismatch; start google-auth again');
  const code = url.searchParams.get('code');
  if (!code) throw new Error('No authorization code in that URL');
  return code;
}

export async function exchangeCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  verifier: string;
  redirectUri: string;
  fetchImpl?: FetchLike;
}): Promise<{ refreshToken: string; scope: string | null }> {
  const response = await (params.fetchImpl ?? fetch)(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      code_verifier: params.verifier,
      grant_type: 'authorization_code',
      redirect_uri: params.redirectUri,
    }).toString(),
  });
  const payload = await response.json().catch(() => ({})) as { refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (!response.ok) throw new Error(`Token exchange failed: ${payload.error_description || payload.error || `HTTP ${response.status}`}`);
  if (!payload.refresh_token) {
    throw new Error('Google did not return a refresh token. Remove the app at https://myaccount.google.com/permissions and run google-auth again.');
  }
  return { refreshToken: payload.refresh_token, scope: payload.scope ?? null };
}

export async function runGoogleAuth(options: GoogleAuthOptions): Promise<string> {
  const log = options.log ?? ((line: string) => console.log(line));
  const state = base64url(randomBytes(16));
  const { verifier, challenge } = createPkcePair();
  const scope = options.scope ?? GOOGLE_CALENDAR_SCOPE;

  let server: Server | null = null;
  let rl: readline.Interface | null = null;
  try {
    const fromBrowser = new Promise<string>((resolve, reject) => {
      server = createServer((req, res) => {
        try {
          const code = codeFromRedirect(req.url ?? '/', state);
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('ScallopBot: authorization received. You can close this tab.');
          resolve(code);
        } catch (error) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end(`ScallopBot: ${(error as Error).message}`);
          if (new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.has('state')) reject(error);
        }
      });
      server.on('error', reject);
    });
    await new Promise<void>(resolve => server!.listen(options.port ?? 0, '127.0.0.1', resolve));
    const redirectUri = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

    log('Open this URL in a browser and allow access:\n');
    log(buildAuthUrl({ clientId: options.clientId, redirectUri, scope, state, challenge }));
    log(`\nWaiting for Google to redirect to ${redirectUri} ...`);
    log('If the browser is on another machine, copy the URL it lands on (it will fail to load) and paste it here.\n');

    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    const fromPaste = new Promise<string>((resolve, reject) => {
      rl!.on('line', line => {
        if (!line.trim()) return;
        try {
          resolve(codeFromRedirect(line, state));
        } catch (error) {
          reject(error);
        }
      });
    });

    const code = await Promise.race([fromBrowser, fromPaste]);
    const { refreshToken, scope: granted } = await exchangeCode({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      code,
      verifier,
      redirectUri,
      fetchImpl: options.fetchImpl,
    });
    if (granted) log(`Granted scope: ${granted}`);
    return refreshToken;
  } finally {
    rl?.close();
    (server as Server | null)?.close();
  }
}
