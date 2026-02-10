import type { MemoryNode, MemoryEdge } from '../../hooks/useMemoryGraph';

export interface ProcessedNode {
  index: number;
  memory: MemoryNode;
  position: [number, number, number];
  color: string;
  size: number;
  opacity: number;
  visible: boolean;
}

export interface ProcessedEdge {
  source: [number, number, number];
  target: [number, number, number];
  relationType: string;
  color: string;
  relation: MemoryEdge;
}

export interface FilterState {
  categories: Set<string>;
  searchQuery: string;
  minImportance: number;
  minProminence: number;
}

export interface MapInteractionState {
  hoveredIndex: number | null;
  selectedIndex: number | null;
}
