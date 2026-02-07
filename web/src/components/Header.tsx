import type { ConnectionStatus } from '../hooks/useWebSocket';

interface HeaderProps {
  status: ConnectionStatus;
  debugMode: boolean;
  onDebugToggle: (enabled: boolean) => void;
  onCreditsToggle: () => void;
  creditsAvailable: boolean;
  hasSpend: boolean;
  creditsOpen: boolean;
}

const STATUS_CONFIG = {
  connected: { text: 'online', dotClass: 'bg-green-500' },
  connecting: { text: 'connecting...', dotClass: 'bg-yellow-400' },
  disconnected: { text: 'offline', dotClass: 'bg-gray-400' },
} as const;

export default function Header({
  status,
  debugMode,
  onDebugToggle,
  onCreditsToggle,
  creditsAvailable,
  hasSpend,
  creditsOpen,
}: HeaderProps) {
  const { text, dotClass } = STATUS_CONFIG[status];

  return (
    <header className="flex items-center justify-between px-4 py-2 border-b border-gray-200 bg-white min-h-14">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center shrink-0">
          <span className="text-xl">🐚</span>
        </div>
        <div>
          <h1 className="text-base font-semibold text-gray-900">Scallopbot</h1>
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <span className={`w-2 h-2 rounded-full ${dotClass}`} />
            {text}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {creditsAvailable && (
          <button
            onClick={onCreditsToggle}
            className={`relative p-1.5 rounded-lg transition-colors ${
              creditsOpen
                ? 'text-blue-500 bg-blue-50'
                : 'text-gray-400 hover:text-blue-500 hover:bg-gray-50'
            }`}
            title="Credits usage"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
            {hasSpend && !creditsOpen && (
              <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-blue-500 rounded-full" />
            )}
          </button>
        )}

        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={debugMode}
            onChange={(e) => onDebugToggle(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-9 h-5 bg-gray-200 rounded-full peer-checked:bg-blue-500 relative transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-4 after:h-4 after:bg-white after:rounded-full after:transition-transform peer-checked:after:translate-x-4" />
          <span className="text-xs text-gray-500 hidden sm:inline">Debug</span>
        </label>
      </div>
    </header>
  );
}
