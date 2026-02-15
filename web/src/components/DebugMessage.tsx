import { useState } from 'react';
import type { ChatMessage } from '../App';

interface DebugMessageProps {
  message: ChatMessage;
}

const LABEL_STYLES: Record<string, string> = {
  'tool-start': 'bg-blue-100 dark:bg-gray-700 text-blue-700 dark:text-gray-300 border-blue-300 dark:border-gray-600',
  'tool-complete': 'bg-green-100 dark:bg-gray-700 text-green-700 dark:text-gray-300 border-green-300 dark:border-gray-600',
  'tool-error': 'bg-red-100 dark:bg-gray-700 text-red-700 dark:text-red-300 border-red-300 dark:border-gray-600',
  memory: 'bg-purple-100 dark:bg-gray-700 text-purple-700 dark:text-gray-300 border-purple-300 dark:border-gray-600',
  thinking: 'bg-orange-100 dark:bg-gray-700 text-orange-700 dark:text-gray-300 border-orange-300 dark:border-gray-600',
};

const BORDER_STYLES: Record<string, string> = {
  'tool-start': 'border-blue-200 dark:border-gray-700',
  'tool-complete': 'border-green-200 dark:border-gray-700',
  'tool-error': 'border-red-200 dark:border-gray-700',
  memory: 'border-purple-200 dark:border-gray-700',
  thinking: 'border-orange-200 dark:border-gray-700',
};

const MEMORY_TYPE_STYLES: Record<string, string> = {
  fact: 'bg-purple-100 dark:bg-gray-700 text-purple-700 dark:text-gray-300',
  conversation: 'bg-blue-100 dark:bg-gray-700 text-blue-700 dark:text-gray-300',
};

export default function DebugMessage({ message }: DebugMessageProps) {
  const [expanded, setExpanded] = useState(false);
  const debugType = message.debugType || '';
  const borderStyle = BORDER_STYLES[debugType] || 'border-gray-200 dark:border-gray-700';
  const labelStyle = LABEL_STYLES[debugType] || 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400';
  const items = message.memoryItems;
  const hasItems = items && items.length > 0;

  return (
    <div
      className={`self-start max-w-[80%] max-md:max-w-[95%] p-2 rounded-lg border border-dashed ${borderStyle} font-mono text-xs text-gray-500 dark:text-gray-400 animate-[fade-in_0.15s_ease-out]`}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <span
          className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium ${labelStyle}`}
        >
          {message.label || 'debug'}
        </span>
        {message.type === 'memory' ? (
          <span className="flex-1 text-gray-500 dark:text-gray-400">{message.content}</span>
        ) : null}
        {hasItems && (
          <button
            onClick={() => setExpanded((e) => !e)}
            className="text-purple-500 dark:text-purple-400 text-[10px] px-1.5 py-0.5 rounded hover:bg-purple-50 dark:hover:bg-purple-900/30 transition-colors"
          >
            {expanded ? '\u25BC' : '\u25B6'}
          </button>
        )}
      </div>

      {/* Content (non-memory) */}
      {message.type !== 'memory' && (
        <div className="mt-1 whitespace-pre-wrap break-words">{message.content}</div>
      )}

      {/* Expandable memory items */}
      {hasItems && expanded && (
        <div className="mt-2 pt-2 border-t border-dashed border-gray-200 dark:border-gray-700 space-y-1">
          {items!.map((item, i) => (
            <div key={i} className="flex gap-2 py-0.5">
              <span
                className={`text-[9px] px-1 py-0.5 rounded uppercase shrink-0 ${
                  MEMORY_TYPE_STYLES[item.type] || 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                }`}
              >
                {item.type}
              </span>
              <span className="text-[11px] text-gray-600 dark:text-gray-400 leading-snug">
                {item.subject ? `[${item.subject}] ${item.content}` : item.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
