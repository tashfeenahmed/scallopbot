import { useState } from 'react';
import type { ChatMessage } from '../App';

interface DebugMessageProps {
  message: ChatMessage;
}

const LABEL_STYLES: Record<string, string> = {
  'tool-start': 'bg-blue-100 text-blue-700 border-blue-300',
  'tool-complete': 'bg-green-100 text-green-700 border-green-300',
  'tool-error': 'bg-red-100 text-red-700 border-red-300',
  memory: 'bg-purple-100 text-purple-700 border-purple-300',
  thinking: 'bg-orange-100 text-orange-700 border-orange-300',
};

const BORDER_STYLES: Record<string, string> = {
  'tool-start': 'border-blue-200',
  'tool-complete': 'border-green-200',
  'tool-error': 'border-red-200',
  memory: 'border-purple-200',
  thinking: 'border-orange-200',
};

const MEMORY_TYPE_STYLES: Record<string, string> = {
  fact: 'bg-purple-100 text-purple-700',
  conversation: 'bg-blue-100 text-blue-700',
};

export default function DebugMessage({ message }: DebugMessageProps) {
  const [expanded, setExpanded] = useState(false);
  const debugType = message.debugType || '';
  const borderStyle = BORDER_STYLES[debugType] || 'border-gray-200';
  const labelStyle = LABEL_STYLES[debugType] || 'bg-gray-100 text-gray-600';
  const items = message.memoryItems;
  const hasItems = items && items.length > 0;

  return (
    <div
      className={`self-start max-w-[80%] max-md:max-w-[95%] p-2 rounded-lg border border-dashed ${borderStyle} font-mono text-xs text-gray-500 animate-[fade-in_0.15s_ease-out]`}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <span
          className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium ${labelStyle}`}
        >
          {message.label || 'debug'}
        </span>
        {message.type === 'memory' ? (
          <span className="flex-1 text-gray-500">{message.content}</span>
        ) : null}
        {hasItems && (
          <button
            onClick={() => setExpanded((e) => !e)}
            className="text-purple-500 text-[10px] px-1.5 py-0.5 rounded hover:bg-purple-50 transition-colors"
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
        <div className="mt-2 pt-2 border-t border-dashed border-gray-200 space-y-1">
          {items!.map((item, i) => (
            <div key={i} className="flex gap-2 py-0.5">
              <span
                className={`text-[9px] px-1 py-0.5 rounded uppercase shrink-0 ${
                  MEMORY_TYPE_STYLES[item.type] || 'bg-gray-100 text-gray-600'
                }`}
              >
                {item.type}
              </span>
              <span className="text-[11px] text-gray-600 leading-snug">
                {item.subject ? `[${item.subject}] ${item.content}` : item.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
