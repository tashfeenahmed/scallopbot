import { useEffect, useRef } from 'react';
import { type CommandDefinition } from '../commands';

interface CommandMenuProps {
  commands: CommandDefinition[];
  activeIndex: number;
  onSelect: (cmd: CommandDefinition) => void;
}

export default function CommandMenu({ commands, activeIndex, onSelect }: CommandMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll active item into view when navigating with keyboard
  useEffect(() => {
    if (listRef.current && activeIndex >= 0) {
      const items = listRef.current.querySelectorAll('[data-cmd-item]');
      items[activeIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  const builtins = commands.filter((c) => c.category === 'builtin');
  const skills = commands.filter((c) => c.category === 'skill');

  if (commands.length === 0) {
    return (
      <div className="absolute bottom-full mb-2 left-0 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg overflow-hidden animate-[slide-up_150ms_ease-out]">
        <div className="px-4 py-3 text-sm text-gray-400 dark:text-gray-500">
          No matching commands
        </div>
      </div>
    );
  }

  let itemIndex = -1;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full mb-2 left-0 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg overflow-hidden animate-[slide-up_150ms_ease-out] max-h-72 overflow-y-auto"
    >
      {builtins.length > 0 && (
        <div>
          <div className="px-4 pt-3 pb-1 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
            Commands
          </div>
          {builtins.map((cmd) => {
            itemIndex++;
            const idx = itemIndex;
            return (
              <button
                key={cmd.name}
                data-cmd-item
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(cmd);
                }}
                className={`w-full text-left px-4 py-2 flex items-center gap-3 transition-colors ${
                  idx === activeIndex
                    ? 'bg-blue-50 dark:bg-blue-900/30'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
                }`}
              >
                <span className="text-sm font-mono text-gray-900 dark:text-gray-100">
                  /{cmd.name}
                </span>
                <span className="text-sm text-gray-400 dark:text-gray-500">
                  {cmd.description}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {skills.length > 0 && (
        <div>
          <div className={`px-4 pt-3 pb-1 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider ${builtins.length > 0 ? 'border-t border-gray-100 dark:border-gray-700' : ''}`}>
            Skills
          </div>
          {skills.map((cmd) => {
            itemIndex++;
            const idx = itemIndex;
            return (
              <button
                key={cmd.name}
                data-cmd-item
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(cmd);
                }}
                className={`w-full text-left px-4 py-2 flex items-center gap-3 transition-colors ${
                  idx === activeIndex
                    ? 'bg-blue-50 dark:bg-blue-900/30'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
                }`}
              >
                <span className="text-sm font-mono text-gray-900 dark:text-gray-100">
                  /{cmd.name}
                </span>
                <span className="text-sm text-gray-400 dark:text-gray-500">
                  {cmd.description}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
