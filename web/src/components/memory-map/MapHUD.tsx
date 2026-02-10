import type { FilterState, ProcessedNode, ProcessedEdge } from './types';
import FilterBar from './FilterBar';
import SearchBox from './SearchBox';
import StatsBar from './StatsBar';
import MemoryTooltip from './MemoryTooltip';
import MemoryDetail from './MemoryDetail';
import TimelinePlayer from './TimelinePlayer';

interface MapHUDProps {
  filters: FilterState;
  visibleCount: number;
  totalCount: number;
  hoveredNode: ProcessedNode | null;
  selectedNode: ProcessedNode | null;
  edges: ProcessedEdge[];
  nodes: ProcessedNode[];
  onToggleCategory: (cat: string) => void;
  onHoverCategory: (cat: string | null) => void;
  onSearchChange: (q: string) => void;
  onCloseDetail: () => void;
  minTime: number;
  maxTime: number;
  timelineCutoff: number;
  onTimelineCutoff: (t: number) => void;
}

export default function MapHUD({
  filters,
  visibleCount,
  totalCount,
  hoveredNode,
  selectedNode,
  edges,
  nodes,
  onToggleCategory,
  onHoverCategory,
  onSearchChange,
  onCloseDetail,
  minTime,
  maxTime,
  timelineCutoff,
  onTimelineCutoff,
}: MapHUDProps) {
  return (
    <div className="absolute inset-0 pointer-events-none">
      {/* Top bar */}
      <div className="absolute top-3 left-3 right-3 flex items-start gap-3 pointer-events-auto">
        <FilterBar categories={filters.categories} onToggle={onToggleCategory} onHoverCategory={onHoverCategory} />
        <TimelinePlayer minTime={minTime} maxTime={maxTime} cutoff={timelineCutoff} onCutoffChange={onTimelineCutoff} />
        <SearchBox value={filters.searchQuery} onChange={onSearchChange} />
      </div>

      {/* Bottom left: stats */}
      <div className="absolute bottom-3 left-3 pointer-events-auto">
        <StatsBar visibleCount={visibleCount} totalCount={totalCount} />
      </div>

      {/* Bottom right: tooltip on hover */}
      {hoveredNode && !selectedNode && (
        <div className="absolute bottom-3 right-3 pointer-events-none">
          <MemoryTooltip node={hoveredNode} />
        </div>
      )}

      {/* Right panel: detail on select */}
      {selectedNode && (
        <div className="absolute top-14 right-3 bottom-3 w-80 pointer-events-auto">
          <MemoryDetail node={selectedNode} edges={edges} nodes={nodes} onClose={onCloseDetail} />
        </div>
      )}
    </div>
  );
}
