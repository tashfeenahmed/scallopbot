import { useCallback, useEffect, useState } from 'react';

export interface CostData {
  enabled: boolean;
  daily: {
    spent: number;
    budget: number | null;
    remaining: number | null;
    exceeded: boolean;
    warning: boolean;
  };
  monthly: {
    spent: number;
    budget: number | null;
    remaining: number | null;
    exceeded: boolean;
    warning: boolean;
  };
  topModels: { model: string; cost: number; percentage: number }[];
  totalRequests: number;
  dailyHistory: { date: string; cost: number; requests: number }[];
}

const POLL_INTERVAL = 30000;

export function useCosts() {
  const [costs, setCosts] = useState<CostData | null>(null);

  const fetchCosts = useCallback(async () => {
    try {
      const res = await fetch('/api/costs');
      const data = await res.json();
      if (data.enabled) {
        setCosts(data);
      } else {
        setCosts(null);
      }
    } catch {
      console.error('Failed to fetch costs');
    }
  }, []);

  const setBudgets = useCallback(async (budgets: { dailyBudget?: number | null; monthlyBudget?: number | null }): Promise<boolean> => {
    try {
      const res = await fetch('/api/costs/budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(budgets),
      });
      if (!res.ok) return false;
      await fetchCosts();
      return true;
    } catch {
      return false;
    }
  }, [fetchCosts]);

  useEffect(() => {
    fetchCosts();
    const interval = setInterval(fetchCosts, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchCosts]);

  return { costs, refetch: fetchCosts, setBudgets };
}
