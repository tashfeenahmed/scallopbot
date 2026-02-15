import { CATEGORY_COLORS, CATEGORY_LABELS } from './constants';

interface FilterBarProps {
  categories: Set<string>;
  onToggle: (cat: string) => void;
  onHoverCategory: (cat: string | null) => void;
  darkMode: boolean;
}

export default function FilterBar({ categories, onToggle, onHoverCategory, darkMode }: FilterBarProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {Object.entries(CATEGORY_COLORS).map(([cat, color]) => {
        const active = categories.has(cat);
        return (
          <button
            key={cat}
            onClick={() => onToggle(cat)}
            onMouseEnter={() => onHoverCategory(cat)}
            onMouseLeave={() => onHoverCategory(null)}
            className="px-2.5 py-1 rounded-full text-xs font-medium transition-all flex items-center gap-1.5"
            style={{
              backgroundColor: active ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.05)',
              color: active ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)',
              border: 'none',
            }}
          >
            <span
              className="inline-block w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: active ? color : 'rgba(255,255,255,0.3)' }}
            />
            {CATEGORY_LABELS[cat] || cat}
          </button>
        );
      })}
    </div>
  );
}
