import type { ProcessedNode } from './types';
import { CATEGORY_LABELS } from './constants';

interface MemoryTooltipProps {
  node: ProcessedNode;
}

export default function MemoryTooltip({ node }: MemoryTooltipProps) {
  const { memory, color } = node;
  const truncated = memory.content.length > 120
    ? memory.content.slice(0, 120) + '...'
    : memory.content;

  return (
    <div className="w-72 rounded-lg bg-gray-900/90 border border-gray-700/50 p-3 backdrop-blur-sm shadow-xl">
      <div className="flex items-center gap-2 mb-2">
        <span
          className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
        <span className="text-xs font-medium text-gray-300">
          {CATEGORY_LABELS[memory.category] || memory.category}
        </span>
        {!memory.isLatest && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700/50 text-gray-500">superseded</span>
        )}
      </div>
      <p className="text-xs text-gray-400 leading-relaxed mb-2">{truncated}</p>
      <div className="flex gap-3">
        <div className="flex-1">
          <div className="text-[10px] text-gray-500 mb-0.5">Importance</div>
          <div className="h-1 rounded-full bg-gray-800 overflow-hidden">
            <div className="h-full rounded-full bg-blue-400" style={{ width: `${memory.importance * 10}%` }} />
          </div>
        </div>
        <div className="flex-1">
          <div className="text-[10px] text-gray-500 mb-0.5">Prominence</div>
          <div className="h-1 rounded-full bg-gray-800 overflow-hidden">
            <div className="h-full rounded-full bg-purple-400" style={{ width: `${memory.prominence * 100}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}
