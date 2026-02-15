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
            className="px-2.5 py-1 rounded-full text-xs font-medium transition-all"
            style={{
              backgroundColor: active
                ? color + '30'
                : darkMode ? 'rgba(17,24,39,0.7)' : 'rgba(255,255,255,0.85)',
              color: active ? color : darkMode ? '#6b7280' : '#6b7280',
              border: `1px solid ${active ? color + '60' : darkMode ? 'rgba(75,85,99,0.3)' : 'rgba(209,213,219,0.8)'}`,
              backdropFilter: 'blur(8px)',
            }}
          >
            <span
              className="inline-block w-2 h-2 rounded-full mr-1.5"
              style={{ backgroundColor: active ? color : darkMode ? '#4b5563' : '#9ca3af' }}
            />
            {CATEGORY_LABELS[cat] || cat}
          </button>
        );
      })}
    </div>
  );
}
