import { useState, useMemo, useCallback } from 'react';
import { useMemoryGraph } from '../../hooks/useMemoryGraph';
import { CATEGORY_COLORS, RELATION_COLORS, nodeSize } from './constants';
import type { ProcessedNode, ProcessedEdge, FilterState, MapInteractionState } from './types';
import GraphScene from './GraphScene';
import MapHUD from './MapHUD';

const ALL_CATEGORIES = new Set(Object.keys(CATEGORY_COLORS));

export default function MemoryMap() {
  const { data, state, error, refetch } = useMemoryGraph();

  const [filters, setFilters] = useState<FilterState>({
    categories: new Set(ALL_CATEGORIES),
    searchQuery: '',
    minImportance: 1,
    minProminence: 0,
  });

  const [interaction, setInteraction] = useState<MapInteractionState>({
    hoveredIndex: null,
    selectedIndex: null,
  });

  const nodes = useMemo<ProcessedNode[]>(() => {
    if (!data) return [];
    const searchLower = filters.searchQuery.toLowerCase();

    // Compute actual min/max prominence so we can spread opacity across the real range
    let minProm = Infinity, maxProm = -Infinity;
    for (const m of data.memories) {
      if (m.prominence < minProm) minProm = m.prominence;
      if (m.prominence > maxProm) maxProm = m.prominence;
    }
    const promRange = maxProm - minProm || 1;

    return data.memories.map((memory, index) => {
      let position = data.positions?.[memory.id];
      if (!position) {
        // Random point on a sphere
        const theta = Math.random() * 2 * Math.PI;
        const phi = Math.acos(2 * Math.random() - 1);
        const r = 8 + Math.random() * 2;
        position = [
          r * Math.sin(phi) * Math.cos(theta),
          r * Math.sin(phi) * Math.sin(theta),
          r * Math.cos(phi),
        ];
      }
      const color = CATEGORY_COLORS[memory.category] || '#9ca3af';
      const visible =
        filters.categories.has(memory.category) &&
        memory.importance >= filters.minImportance &&
        memory.prominence >= filters.minProminence &&
        (!searchLower || memory.content.toLowerCase().includes(searchLower));

      // Relative opacity: spread actual prominence range across 0.12 – 1.0
      const normalizedProm = (memory.prominence - minProm) / promRange;
      const opacity = 0.12 + normalizedProm * 0.88;

      return {
        index,
        memory,
        position: position as [number, number, number],
        color,
        size: nodeSize(memory.importance),
        opacity,
        visible,
      };
    });
  }, [data, filters]);

  const edges = useMemo<ProcessedEdge[]>(() => {
    if (!data) return [];
    const nodeMap = new Map(nodes.map(n => [n.memory.id, n]));

    return data.relations
      .map(rel => {
        const src = nodeMap.get(rel.sourceId);
        const tgt = nodeMap.get(rel.targetId);
        if (!src || !tgt || !src.visible || !tgt.visible) return null;
        return {
          source: src.position,
          target: tgt.position,
          relationType: rel.relationType,
          color: RELATION_COLORS[rel.relationType] || '#6b7280',
          relation: rel,
        };
      })
      .filter((e): e is ProcessedEdge => e !== null);
  }, [data, nodes]);

  const handleHover = useCallback((index: number | null) => {
    setInteraction(prev => ({ ...prev, hoveredIndex: index }));
  }, []);

  const handleSelect = useCallback((index: number | null) => {
    setInteraction(prev => ({ ...prev, selectedIndex: index }));
  }, []);

  const toggleCategory = useCallback((cat: string) => {
    setFilters(prev => {
      const next = new Set(prev.categories);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return { ...prev, categories: next };
    });
  }, []);

  const setSearchQuery = useCallback((q: string) => {
    setFilters(prev => ({ ...prev, searchQuery: q }));
  }, []);

  if (state === 'loading') {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-950 text-gray-400">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p>Loading memory graph...</p>
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-950 text-gray-400">
        <div className="text-center">
          <p className="text-red-400 mb-2">Failed to load memory graph</p>
          <p className="text-sm mb-4">{error}</p>
          <button onClick={refetch} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors">
            Retry
          </button>
        </div>
      </div>
    );
  }

  const visibleCount = nodes.filter(n => n.visible).length;
  const totalCount = nodes.length;
  const hoveredNode = interaction.hoveredIndex !== null ? nodes[interaction.hoveredIndex] : null;
  const selectedNode = interaction.selectedIndex !== null ? nodes[interaction.selectedIndex] : null;

  return (
    <div className="flex-1 relative bg-gray-950 overflow-hidden">
      <GraphScene
        nodes={nodes}
        edges={edges}
        hoveredIndex={interaction.hoveredIndex}
        selectedIndex={interaction.selectedIndex}
        onHover={handleHover}
        onSelect={handleSelect}
      />
      <MapHUD
        filters={filters}
        visibleCount={visibleCount}
        totalCount={totalCount}
        hoveredNode={hoveredNode}
        selectedNode={selectedNode}
        edges={edges}
        nodes={nodes}
        onToggleCategory={toggleCategory}
        onSearchChange={setSearchQuery}
        onCloseDetail={() => handleSelect(null)}
      />
    </div>
  );
}
