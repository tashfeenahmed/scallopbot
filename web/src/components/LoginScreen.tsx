import { useState, type FormEvent } from 'react';

interface LoginScreenProps {
  onLogin: (email: string, password: string) => Promise<void>;
  error: string | null;
  darkMode: boolean;
}

export default function LoginScreen({ onLogin, error, darkMode }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    await onLogin(email, password);
    setLoading(false);
  };

  return (
    <div className={darkMode ? 'dark' : ''}>
      <div className="flex items-center justify-center min-h-screen bg-white dark:bg-gray-950">
        <div className="w-full max-w-sm px-6">
          {/* Logo */}
          <div className="flex justify-center mb-6">
            <div className="w-14 h-14 rounded-full bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 flex items-center justify-center text-gray-800 dark:text-gray-200">
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
                <g transform="translate(4 3)">
                  <line x1="12" y1="22" x2="2" y2="14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="12" y1="22" x2="4" y2="10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="12" y1="22" x2="7" y2="7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="12" y1="22" x2="12" y2="5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="12" y1="22" x2="17" y2="7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="12" y1="22" x2="20" y2="10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="12" y1="22" x2="22" y2="14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </g>
              </svg>
            </div>
          </div>

          <h1 className="text-xl font-semibold text-center text-gray-900 dark:text-gray-100 mb-6">
            Sign in
          </h1>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="login-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Email
              </label>
              <input
                id="login-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoComplete="email"
              />
            </div>

            <div>
              <label htmlFor="login-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Password
              </label>
              <input
                id="login-password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoComplete="current-password"
              />
            </div>

            {error && (
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors disabled:opacity-50"
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
