import { useState, type FormEvent } from 'react';

interface SetupScreenProps {
  onSetup: (email: string, password: string) => Promise<void>;
  error: string | null;
  darkMode: boolean;
}

export default function SetupScreen({ onSetup, error, darkMode }: SetupScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    if (password.length < 8) {
      setLocalError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirm) {
      setLocalError('Passwords do not match');
      return;
    }

    setLoading(true);
    await onSetup(email, password);
    setLoading(false);
  };

  const displayError = localError || error;

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
            Welcome to Scallopbot
          </h1>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="setup-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Email
              </label>
              <input
                id="setup-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoComplete="email"
              />
            </div>

            <div>
              <label htmlFor="setup-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Password
              </label>
              <input
                id="setup-password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="8+ characters"
                autoComplete="new-password"
              />
            </div>

            <div>
              <label htmlFor="setup-confirm" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Confirm Password
              </label>
              <input
                id="setup-confirm"
                type="password"
                required
                minLength={8}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoComplete="new-password"
              />
            </div>

            {displayError && (
              <p className="text-sm text-red-600 dark:text-red-400">{displayError}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
