import { useCallback, useEffect, useState } from 'react';

export type AuthState = 'loading' | 'needs-setup' | 'needs-login' | 'authenticated';

export function useAuth() {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [error, setError] = useState<string | null>(null);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
      if (!res.ok) {
        // Auth not configured (e.g. 404) — treat as authenticated
        setAuthState('authenticated');
        return;
      }
      const data = await res.json();
      if (!data.setupComplete) {
        setAuthState('needs-setup');
      } else if (!data.authenticated) {
        setAuthState('needs-login');
      } else {
        setAuthState('authenticated');
      }
    } catch {
      // Network error or auth not configured — allow through
      setAuthState('authenticated');
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const setup = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Setup failed');
        return;
      }
      setAuthState('authenticated');
    } catch {
      setError('Network error');
    }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = data.retryAfterSec
          ? `Too many attempts. Try again in ${data.retryAfterSec}s.`
          : data.error || 'Login failed';
        setError(msg);
        return;
      }
      setAuthState('authenticated');
    } catch {
      setError('Network error');
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
    } catch {
      // ignore
    }
    setAuthState('needs-login');
  }, []);

  return { authState, error, setup, login, logout };
}
