/**
 * SSRF guard for server-side URL fetches.
 *
 * The bot fetches URLs on behalf of whoever is talking to it: every link in an
 * inbound message is auto-fetched by the media pipeline, and the webfetch skill
 * fetches whatever URL the model asks for. Without a guard those requests run
 * from inside the deployment's own network, so a link such as
 * `http://127.0.0.1:3000/api/...`, `http://192.168.1.1/` or
 * `http://169.254.169.254/latest/meta-data/` turns the bot into a proxy for
 * hosts the sender could never reach directly.
 *
 * `safeFetch` resolves the hostname, rejects loopback/private/link-local/
 * reserved targets, and re-validates every redirect hop instead of letting
 * `redirect: 'follow'` land somewhere internal after a public first hop.
 *
 * This is a network-boundary check, not a sandbox: a hostname whose DNS answer
 * changes between the lookup and the request (DNS rebinding) is not covered.
 */

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/** Redirect hops followed before giving up. Matches the browser default. */
const MAX_REDIRECTS = 5;

export const PRIVATE_URL_ERROR = 'URL points to private/internal network (blocked for security)';

export interface UrlSafetyResult {
  safe: boolean;
  /** Human-readable reason when `safe` is false. */
  reason?: string;
}

function ipv4Octets(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** Loopback, private, link-local, CGNAT, benchmarking, multicast and reserved IPv4. */
function isPrivateIpv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (!octets) return true; // Unparseable: fail closed.
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && b >= 18 && b <= 19) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/%.*$/, ''); // Drop any zone index.
  if (normalized === '::1' || normalized === '::') return true;

  // IPv4-mapped / IPv4-compatible forms such as ::ffff:127.0.0.1 tunnel an
  // IPv4 target through an IPv6 literal, so judge the embedded address.
  const embedded = normalized.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded) return isPrivateIpv4(embedded[1]);

  const head = normalized.split(':')[0];
  if (head.startsWith('fc') || head.startsWith('fd')) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(head)) return true; // fe80::/10 link-local
  if (head.startsWith('ff')) return true; // ff00::/8 multicast
  return false;
}

/** True when a literal IP address belongs to a non-public range. */
export function isPrivateIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true; // Not an IP at all: fail closed.
}

/** Strip the brackets Node keeps around an IPv6 hostname. */
function bareHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Validate a single URL: http(s) only, and every address the hostname resolves
 * to must be publicly routable.
 */
export async function checkUrlIsPublic(rawUrl: string | URL): Promise<UrlSafetyResult> {
  let parsed: URL;
  try {
    parsed = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'Invalid URL format' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `Invalid protocol: ${parsed.protocol}` };
  }

  const hostname = bareHostname(parsed.hostname);
  if (!hostname) return { safe: false, reason: 'Invalid URL format' };

  if (isIP(hostname)) {
    return isPrivateIpAddress(hostname)
      ? { safe: false, reason: PRIVATE_URL_ERROR }
      : { safe: true };
  }

  // `localhost` and friends usually resolve to loopback anyway, but resolvers
  // and /etc/hosts differ; the resolved-address check below is authoritative.
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    return { safe: false, reason: `Could not resolve host: ${hostname}` };
  }

  if (addresses.length === 0) {
    return { safe: false, reason: `Could not resolve host: ${hostname}` };
  }
  if (addresses.some(entry => isPrivateIpAddress(entry.address))) {
    return { safe: false, reason: PRIVATE_URL_ERROR };
  }

  return { safe: true };
}

/** Raised when a fetch target (or one of its redirect hops) is not public. */
export class BlockedUrlError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'BlockedUrlError';
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * `fetch` that refuses internal targets, including after a redirect.
 *
 * Redirects are followed manually so each hop is validated. Throws
 * `BlockedUrlError` when a hop is not publicly routable.
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  options: { maxRedirects?: number } = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  let current = url;
  let requestInit: RequestInit = { ...init, redirect: 'manual' };

  for (let hop = 0; ; hop++) {
    const verdict = await checkUrlIsPublic(current);
    if (!verdict.safe) {
      throw new BlockedUrlError(verdict.reason ?? PRIVATE_URL_ERROR);
    }

    const response = await fetch(current, requestInit);
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response;

    if (hop >= maxRedirects) {
      throw new Error(`Too many redirects (max ${maxRedirects})`);
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new BlockedUrlError('Invalid redirect location');
    }

    // Mirror the fetch spec: 303 (and 301/302 from POST) continue as GET.
    const method = (requestInit.method ?? 'GET').toUpperCase();
    if (response.status === 303 || (method === 'POST' && response.status !== 307 && response.status !== 308)) {
      requestInit = { ...requestInit, method: 'GET', body: undefined };
    }

    current = next.toString();
  }
}
