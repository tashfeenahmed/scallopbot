import { useState, type FormEvent } from 'react';
import type { CostData } from '../hooks/useCosts';
import SpendingChart from './SpendingChart';

interface CreditsPanelProps {
  costs: CostData;
  onSetBudgets: (budgets: { dailyBudget?: number | null; monthlyBudget?: number | null }) => Promise<boolean>;
}

function formatCost(dollars: number): string {
  return '$' + dollars.toFixed(4);
}

function BudgetEditor({ costs, onSetBudgets }: CreditsPanelProps) {
  const [editing, setEditing] = useState(false);
  const [daily, setDaily] = useState(costs.daily.budget?.toString() ?? '');
  const [monthly, setMonthly] = useState(costs.monthly.budget?.toString() ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);

    const parse = (v: string): number | null => {
      const trimmed = v.trim();
      if (trimmed === '') return null;
      const n = parseFloat(trimmed);
      return Number.isFinite(n) && n > 0 ? n : NaN;
    };
    const dailyVal = parse(daily);
    const monthlyVal = parse(monthly);
    if (Number.isNaN(dailyVal) || Number.isNaN(monthlyVal)) {
      setError('Budgets must be positive dollar amounts (leave blank to remove a cap).');
      setSaving(false);
      return;
    }

    const ok = await onSetBudgets({ dailyBudget: dailyVal, monthlyBudget: monthlyVal });
    setSaving(false);
    if (ok) {
      setSaved(true);
      setEditing(false);
      window.setTimeout(() => setSaved(false), 2500);
    } else {
      setError('Could not save budgets. Check your connection and try again.');
    }
  };

  if (!editing && !saved) {
    return (
      <button
        type="button"
        onClick={() => {
          setDaily(costs.daily.budget?.toString() ?? '');
          setMonthly(costs.monthly.budget?.toString() ?? '');
          setError(null);
          setEditing(true);
        }}
        className="mt-3 text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium"
      >
        {costs.daily.budget == null && costs.monthly.budget == null
          ? 'Set spend limits'
          : 'Edit spend limits'}
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
      <div className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">Spend limits (USD)</div>
      <div className="flex gap-3 max-md:flex-col">
        <label className="flex-1 block">
          <span className="block text-[11px] text-gray-500 dark:text-gray-400 mb-1">Daily</span>
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              inputMode="decimal"
              value={daily}
              onChange={(e) => setDaily(e.target.value)}
              placeholder="No limit"
              aria-label="Daily budget in dollars"
              className="w-full pl-6 pr-2 py-1.5 rounded-md border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </label>
        <label className="flex-1 block">
          <span className="block text-[11px] text-gray-500 dark:text-gray-400 mb-1">Monthly</span>
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              inputMode="decimal"
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
              placeholder="No limit"
              aria-label="Monthly budget in dollars"
              className="w-full pl-6 pr-2 py-1.5 rounded-md border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </label>
      </div>
      <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-2">
        The bot stops answering once a limit is hit. Leave a field blank for no limit. Limits persist across restarts.
      </p>
      {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</p>}
      {saved && !editing && <p className="text-xs text-green-600 dark:text-green-400 mt-2">Spend limits saved.</p>}
      {editing && (
        <div className="flex gap-2 mt-3">
          <button
            type="submit"
            disabled={saving}
            className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => { setEditing(false); setError(null); }}
            className="px-3 py-1.5 rounded-md border border-gray-300 dark:border-neutral-700 text-gray-700 dark:text-gray-300 text-xs font-medium"
          >
            Cancel
          </button>
        </div>
      )}
    </form>
  );
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
    <div className="h-1.5 bg-gray-100 dark:bg-gray-700 rounded-full mt-2 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-300 ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default function CreditsPanel({ costs, onSetBudgets }: CreditsPanelProps) {
  return (
    <div className="flex-1 overflow-y-auto px-[10%] py-6 bg-gray-50 dark:bg-gray-950 max-md:px-4">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Cost Dashboard</h1>
        <BudgetEditor costs={costs} onSetBudgets={onSetBudgets} />

        <div className="flex gap-3">
          {/* Daily */}
          <div className="flex-1 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
            <div className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wide">Today</div>
            <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mt-1">
              {formatCost(costs.daily.spent)}
            </div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
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
          <div className="flex-1 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
            <div className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wide">This Month</div>
            <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mt-1">
              {formatCost(costs.monthly.spent)}
            </div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
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
          <div className="flex-1 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
            <div className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wide">Requests</div>
            <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mt-1">{costs.totalRequests}</div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">total</div>
          </div>
        </div>

        {/* Model breakdown */}
        {costs.topModels.length > 0 && (
          <div className="mt-4">
            <div className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Models</div>
            <div className="flex flex-wrap gap-1.5">
              {costs.topModels.map((m) => (
                <div
                  key={m.model}
                  className="inline-flex items-center gap-1.5 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1 text-[11px]"
                >
                  <span className="text-gray-500 dark:text-gray-400 font-mono">{m.model}</span>
                  <span className="text-blue-500 font-medium">{formatCost(m.cost)}</span>
                  <span className="text-gray-400 dark:text-gray-500 text-[10px]">({m.percentage}%)</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {costs.dailyHistory?.length > 0 && (
          <div className="mt-4">
            <SpendingChart dailyHistory={costs.dailyHistory} />
          </div>
        )}
      </div>
    </div>
  );
}
