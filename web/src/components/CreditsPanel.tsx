import type { CostData } from '../hooks/useCosts';

interface CreditsPanelProps {
  costs: CostData;
}

function formatCost(dollars: number): string {
  return '$' + dollars.toFixed(4);
}

function BarFill({ spent, budget, exceeded, warning }: {
  spent: number;
  budget: number | null;
  exceeded: boolean;
  warning: boolean;
}) {
  if (budget == null) return null;
  const pct = Math.min((spent / budget) * 100, 100);
  const color = exceeded ? 'bg-red-400' : warning ? 'bg-yellow-400' : 'bg-blue-500';
  return (
    <div className="h-1 bg-gray-100 rounded-full mt-2 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-300 ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default function CreditsPanel({ costs }: CreditsPanelProps) {
  return (
    <div className="border-b border-gray-200 px-[10%] py-3 animate-[slide-down_0.15s_ease-out]">
      <div className="max-w-3xl mx-auto">
        <div className="flex gap-3">
          {/* Daily */}
          <div className="flex-1 border border-gray-200 rounded-lg p-2.5">
            <div className="text-[11px] text-gray-500 uppercase tracking-wide">Today</div>
            <div className="text-xl font-semibold text-gray-900">
              {formatCost(costs.daily.spent)}
            </div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              {costs.daily.budget != null
                ? `of $${costs.daily.budget.toFixed(2)} budget`
                : 'no budget set'}
            </div>
            <BarFill
              spent={costs.daily.spent}
              budget={costs.daily.budget}
              exceeded={costs.daily.exceeded}
              warning={costs.daily.warning}
            />
          </div>

          {/* Monthly */}
          <div className="flex-1 border border-gray-200 rounded-lg p-2.5">
            <div className="text-[11px] text-gray-500 uppercase tracking-wide">This Month</div>
            <div className="text-xl font-semibold text-gray-900">
              {formatCost(costs.monthly.spent)}
            </div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              {costs.monthly.budget != null
                ? `of $${costs.monthly.budget.toFixed(2)} budget`
                : 'no budget set'}
            </div>
            <BarFill
              spent={costs.monthly.spent}
              budget={costs.monthly.budget}
              exceeded={costs.monthly.exceeded}
              warning={costs.monthly.warning}
            />
          </div>

          {/* Requests */}
          <div className="flex-1 border border-gray-200 rounded-lg p-2.5">
            <div className="text-[11px] text-gray-500 uppercase tracking-wide">Requests</div>
            <div className="text-xl font-semibold text-gray-900">{costs.totalRequests}</div>
            <div className="text-[11px] text-gray-500 mt-0.5">total</div>
          </div>
        </div>

        {/* Model breakdown */}
        {costs.topModels.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {costs.topModels.map((m) => (
              <div
                key={m.model}
                className="inline-flex items-center gap-1.5 border border-gray-200 rounded-md px-2 py-1 text-[11px]"
              >
                <span className="text-gray-500 font-mono">{m.model}</span>
                <span className="text-blue-500 font-medium">{formatCost(m.cost)}</span>
                <span className="text-gray-400 text-[10px]">({m.percentage}%)</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
