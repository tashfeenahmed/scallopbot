interface SpendingChartProps {
  dailyHistory: { date: string; cost: number; requests: number }[];
}

function formatCost(dollars: number): string {
  return '$' + dollars.toFixed(4);
}

export default function SpendingChart({ dailyHistory }: SpendingChartProps) {
  // Show last 14 days
  const data = dailyHistory.slice(-14);
  if (data.length === 0) return null;

  const maxCost = Math.max(...data.map((d) => d.cost));
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mt-2.5">
      <div className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
        Daily Spend (last {data.length}d)
      </div>
      <div className="flex items-end gap-[3px] h-16">
        {data.map((d) => {
          const height = maxCost > 0 ? (d.cost / maxCost) * 100 : 0;
          const isToday = d.date === today;
          return (
            <div
              key={d.date}
              className="flex-1 flex flex-col items-center justify-end h-full"
            >
              <div
                className={`w-full rounded-sm transition-all duration-300 ${
                  isToday ? 'bg-gray-100 dark:bg-gray-200' : 'bg-gray-400 dark:bg-gray-600'
                }`}
                style={{ height: `${Math.max(height, 2)}%` }}
                title={`${d.date}: ${formatCost(d.cost)} (${d.requests} req)`}
              />
            </div>
          );
        })}
      </div>
      <div className="flex gap-[3px] mt-0.5">
        {data.map((d) => (
          <div
            key={d.date}
            className="flex-1 text-center text-[8px] text-gray-400 dark:text-gray-500 truncate"
          >
            {d.date.slice(5)}
          </div>
        ))}
      </div>
    </div>
  );
}
