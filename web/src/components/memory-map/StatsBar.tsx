import { CATEGORY_COLORS, CATEGORY_LABELS } from './constants';

interface StatsBarProps {
  visibleCount: number;
  totalCount: number;
}

export default function StatsBar({ visibleCount, totalCount }: StatsBarProps) {
  return (
    <div className="rounded-lg bg-gray-900/80 border border-gray-700/50 backdrop-blur-sm px-3 py-2">
      <div className="text-xs text-gray-400 mb-1.5">
        <span className="text-gray-200 font-medium">{visibleCount}</span>
        <span className="text-gray-500"> / {totalCount} memories</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
          <div key={cat} className="flex items-center gap-1 text-[10px] text-gray-500">
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
            {CATEGORY_LABELS[cat] || cat}
          </div>
        ))}
      </div>
    </div>
  );
}
