import { CATEGORY_COLORS, CATEGORY_LABELS } from './constants';

interface FilterBarProps {
  categories: Set<string>;
  onToggle: (cat: string) => void;
  onHoverCategory: (cat: string | null) => void;
}

export default function FilterBar({ categories, onToggle, onHoverCategory }: FilterBarProps) {
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
              backgroundColor: active ? color + '30' : 'rgba(17,24,39,0.7)',
              color: active ? color : '#6b7280',
              border: `1px solid ${active ? color + '60' : 'rgba(75,85,99,0.3)'}`,
              backdropFilter: 'blur(8px)',
            }}
          >
            <span
              className="inline-block w-2 h-2 rounded-full mr-1.5"
              style={{ backgroundColor: active ? color : '#4b5563' }}
            />
            {CATEGORY_LABELS[cat] || cat}
          </button>
        );
      })}
    </div>
  );
}
