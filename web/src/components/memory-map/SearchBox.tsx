interface SearchBoxProps {
  value: string;
  onChange: (q: string) => void;
}

export default function SearchBox({ value, onChange }: SearchBoxProps) {
  return (
    <div className="relative ml-auto">
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="Search memories..."
        className="w-48 px-3 py-1.5 pl-8 text-xs rounded-lg bg-gray-900/80 border border-gray-700/50 text-gray-300 placeholder-gray-500 focus:outline-none focus:border-blue-500/50 backdrop-blur-sm"
      />
      <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" />
        <path d="M21 21l-4.35-4.35" />
      </svg>
    </div>
  );
}
