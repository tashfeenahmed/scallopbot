import { connectionBanner } from '../hooks/connection';
import type { ConnectionStatus } from '../hooks/useWebSocket';

/** Offline explanation + manual retry. Without it the composer just greys
 *  out mid-chat and, once the reconnect budget is spent, nothing short of a
 *  page refresh recovers the socket. */
export default function ConnectionBanner({
  status,
  onRetry,
}: {
  status: ConnectionStatus;
  onRetry: () => void;
}) {
  const banner = connectionBanner(status);
  if (!banner) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center justify-between gap-3 px-4 py-2 text-xs font-medium border-t ${
        banner.tone === 'dead'
          ? 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900'
          : 'bg-yellow-50 dark:bg-yellow-950/40 text-yellow-800 dark:text-yellow-300 border-yellow-200 dark:border-yellow-900'
      }`}
    >
      <span>{banner.text}</span>
      {banner.showRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="px-3 py-1 rounded-full border border-current font-semibold hover:opacity-80 transition-opacity"
        >
          Try now
        </button>
      )}
    </div>
  );
}
