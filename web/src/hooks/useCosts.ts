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

  useEffect(() => {
    fetchCosts();
    const interval = setInterval(fetchCosts, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchCosts]);

  return { costs, refetch: fetchCosts };
}
