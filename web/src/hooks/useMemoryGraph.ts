import { useState, useEffect, useCallback } from 'react';

export interface MemoryNode {
  id: string;
  content: string;
  category: string;
  memoryType: string;
  importance: number;
  confidence: number;
  prominence: number;
  isLatest: boolean;
  hasEmbedding: boolean;
  accessCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: string;
  confidence: number;
  createdAt: number;
}

export interface MemoryGraphData {
  memories: MemoryNode[];
  relations: MemoryEdge[];
  positions: Record<string, [number, number, number]> | null;
}

export type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

export function useMemoryGraph() {
  const [data, setData] = useState<MemoryGraphData | null>(null);
  const [state, setState] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const res = await fetch('/api/memories/graph');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: MemoryGraphData = await res.json();
      setData(json);
      setState('loaded');
    } catch (err) {
      setError((err as Error).message);
      setState('error');
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, state, error, refetch };
}
