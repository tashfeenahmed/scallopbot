import type { ConnectionStatus } from '../hooks/useWebSocket';
import type { ViewMode } from '../App';

interface SidebarProps {
  status: ConnectionStatus;
  currentView: ViewMode;
  onViewChange: (view: ViewMode) => void;
  darkMode: boolean;
  onDarkModeToggle: () => void;
  debugMode: boolean;
  onDebugToggle: (enabled: boolean) => void;
  costsAvailable: boolean;
  hasSpend: boolean;
  onLogout?: () => void;
}

const STATUS_DOT: Record<ConnectionStatus, string> = {
  connected: 'bg-green-500',
  connecting: 'bg-yellow-400',
  disconnected: 'bg-gray-400',
};

export default function Sidebar({
  status,
  currentView,
  onViewChange,
  darkMode,
  onDarkModeToggle,
  debugMode,
  onDebugToggle,
  costsAvailable,
  hasSpend,
  onLogout,
}: SidebarProps) {
  return (
    <aside className="flex flex-col items-center w-16 shrink-0 border-r border-gray-200 dark:border-neutral-800 bg-gray-50 dark:bg-black py-3 gap-1">
      {/* Logo + status */}
      <div className="relative mb-3">
        <div className="w-10 h-10 rounded-full bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 flex items-center justify-center text-gray-800 dark:text-gray-200">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 32 32">
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
        <span
          className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-gray-50 dark:border-black ${STATUS_DOT[status]}`}
          title={status}
        />
      </div>

      {/* Nav items */}
      <NavButton
        active={currentView === 'chat'}
        onClick={() => onViewChange('chat')}
        title="Chat"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </NavButton>

      <NavButton
        active={currentView === 'memory-map'}
        onClick={() => onViewChange('memory-map')}
        title="Memory"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v4m0 12v4m10-10h-4M6 12H2m15.07-7.07-2.83 2.83M9.76 14.24l-2.83 2.83m0-10.14 2.83 2.83m4.48 4.48 2.83 2.83" />
        </svg>
      </NavButton>

      {costsAvailable && (
        <NavButton
          active={currentView === 'costs'}
          onClick={() => onViewChange('costs')}
          title="Costs"
          badge={hasSpend && currentView !== 'costs'}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
        </NavButton>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Debug toggle */}
      <button
        onClick={() => onDebugToggle(!debugMode)}
        className={`w-10 h-10 flex items-center justify-center rounded-xl transition-colors ${
          debugMode
            ? 'bg-gray-200 dark:bg-neutral-700 text-gray-900 dark:text-gray-100'
            : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-800'
        }`}
        title={debugMode ? 'Debug on' : 'Debug off'}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 12h.01M8 12h.01M16 12h.01M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9 9 4.03 9 9z" />
        </svg>
      </button>

      {/* Logout button */}
      {onLogout && (
        <button
          onClick={onLogout}
          className="w-10 h-10 flex items-center justify-center rounded-xl text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors"
          title="Sign out"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      )}

      {/* Dark mode toggle */}
      <button
        onClick={onDarkModeToggle}
        className="w-10 h-10 flex items-center justify-center rounded-xl text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors"
        title={darkMode ? 'Light mode' : 'Dark mode'}
      >
        {darkMode ? (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="5" />
            <path d="M12 1v2m0 18v2m-9-11h2m18 0h2m-4.22-6.78 1.42-1.42M4.22 19.78l1.42-1.42M4.22 4.22 5.64 5.64m12.72 12.72 1.42 1.42" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        )}
      </button>
    </aside>
  );
}

function NavButton({
  active,
  onClick,
  title,
  children,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  badge?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative w-10 h-10 flex flex-col items-center justify-center rounded-xl transition-colors ${
        active
          ? 'bg-gray-200 dark:bg-neutral-700 text-gray-900 dark:text-gray-100'
          : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-800'
      }`}
      title={title}
    >
      {children}
      <span className="text-[9px] font-medium mt-0.5 leading-none">{title}</span>
      {badge && (
        <span className="absolute top-1 right-1 w-2 h-2 bg-blue-500 rounded-full" />
      )}
    </button>
  );
}
