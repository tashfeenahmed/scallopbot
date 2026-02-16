/**
 * Web UI Authentication Service
 *
 * Single-user password login with secure session cookies.
 * First visit triggers account setup; subsequent visits show login.
 */

import { randomBytes } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ScallopDatabase } from '../memory/db.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SESSION_COOKIE = 'sb_session';

// ============ Rate Limiter ============

interface RateLimitEntry {
  attempts: number;
  lockedUntil: number;
}

class LoginRateLimiter {
  private attempts = new Map<string, RateLimitEntry>();
  private readonly maxAttempts = 5;
  private readonly lockoutMs = 15 * 60 * 1000; // 15 minutes

  check(ip: string): { allowed: boolean; retryAfterSec?: number } {
    const entry = this.attempts.get(ip);
    if (!entry) return { allowed: true };

    if (entry.lockedUntil > Date.now()) {
      const retryAfterSec = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
      return { allowed: false, retryAfterSec };
    }

    // Lockout expired — reset
    if (entry.lockedUntil > 0) {
      this.attempts.delete(ip);
    }

    return { allowed: true };
  }

  record(ip: string): void {
    const entry = this.attempts.get(ip) || { attempts: 0, lockedUntil: 0 };
    entry.attempts++;
    if (entry.attempts >= this.maxAttempts) {
      entry.lockedUntil = Date.now() + this.lockoutMs;
    }
    this.attempts.set(ip, entry);
  }

  clear(ip: string): void {
    this.attempts.delete(ip);
  }
}

// ============ Cookie helpers ============

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie || '';
  const cookies: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name] = rest.join('=');
  }
  return cookies;
}

function setSessionCookie(
  res: ServerResponse,
  token: string,
  ttlMs: number,
  req: IncomingMessage,
): void {
  const maxAge = Math.floor(ttlMs / 1000);
  const host = req.headers.host || '';
  const isLocalhost = host.startsWith('localhost') || host.startsWith('127.0.0.1');
  let cookie = `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
  if (!isLocalhost) cookie += '; Secure';
  res.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
    return first.trim();
  }
  return req.socket.remoteAddress || '0.0.0.0';
}

// ============ Auth Service ============

export class AuthService {
  private db: ScallopDatabase;
  private rateLimiter = new LoginRateLimiter();
  private purgeInterval: ReturnType<typeof setInterval>;

  constructor(db: ScallopDatabase) {
    this.db = db;
    // Purge expired sessions every hour
    this.purgeInterval = setInterval(() => {
      this.db.purgeExpiredSessions();
    }, 60 * 60 * 1000);
    // Don't keep process alive
    if (this.purgeInterval.unref) this.purgeInterval.unref();
  }

  destroy(): void {
    clearInterval(this.purgeInterval);
  }

  isSetupComplete(): boolean {
    return this.db.hasAuthUser();
  }

  validateRequest(req: IncomingMessage): boolean {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (!token) return false;
    return this.db.validateAuthSession(token);
  }

  async handleStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const setupComplete = this.isSetupComplete();
    const json = JSON.stringify({ setupComplete, authenticated: false });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(json);
  }

  async handleStatusAuthenticated(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const setupComplete = this.isSetupComplete();
    const authenticated = this.validateRequest(req);
    const json = JSON.stringify({ setupComplete, authenticated });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(json);
  }

  async handleSetup(req: IncomingMessage, res: ServerResponse, body: { email?: string; password?: string }): Promise<void> {
    if (this.db.hasAuthUser()) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Account already exists' }));
      return;
    }

    const { email, password } = body;
    if (!email || !password) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Email and password are required' }));
      return;
    }

    if (password.length < 8) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Password must be at least 8 characters' }));
      return;
    }

    const bcrypt = await import('bcrypt');
    const passwordHash = await bcrypt.hash(password, 12);
    this.db.createAuthUser(email, passwordHash);

    // Auto-login after setup
    const token = randomBytes(32).toString('hex');
    this.db.createAuthSession(token, SESSION_TTL_MS);
    setSessionCookie(res, token, SESSION_TTL_MS, req);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  async handleLogin(req: IncomingMessage, res: ServerResponse, body: { email?: string; password?: string }): Promise<void> {
    const ip = getClientIp(req);
    const limit = this.rateLimiter.check(ip);
    if (!limit.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many attempts. Try again later.', retryAfterSec: limit.retryAfterSec }));
      return;
    }

    const { email, password } = body;
    if (!email || !password) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Email and password are required' }));
      return;
    }

    const user = this.db.getAuthUser();
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid credentials' }));
      return;
    }

    const bcrypt = await import('bcrypt');
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match || email !== user.email) {
      this.rateLimiter.record(ip);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid credentials' }));
      return;
    }

    // Success — clear rate limiter and create session
    this.rateLimiter.clear(ip);
    const token = randomBytes(32).toString('hex');
    this.db.createAuthSession(token, SESSION_TTL_MS);
    setSessionCookie(res, token, SESSION_TTL_MS, req);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  async handleLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (token) {
      this.db.deleteAuthSession(token);
    }
    clearSessionCookie(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }
}
