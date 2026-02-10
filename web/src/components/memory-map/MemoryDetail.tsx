import type { ProcessedNode, ProcessedEdge } from './types';
import { CATEGORY_LABELS, RELATION_COLORS } from './constants';

interface MemoryDetailProps {
  node: ProcessedNode;
  edges: ProcessedEdge[];
  nodes: ProcessedNode[];
  onClose: () => void;
}

export default function MemoryDetail({ node, edges, nodes, onClose }: MemoryDetailProps) {
  const { memory, color } = node;

  // Find related edges
  const relatedEdges = edges.filter(
    e => e.relation.sourceId === memory.id || e.relation.targetId === memory.id
  );

  // Build related node info
  const nodeMap = new Map(nodes.map(n => [n.memory.id, n]));
  const relatedNodes = relatedEdges.map(e => {
    const otherId = e.relation.sourceId === memory.id ? e.relation.targetId : e.relation.sourceId;
    const direction = e.relation.sourceId === memory.id ? 'outgoing' : 'incoming';
    return { edge: e, other: nodeMap.get(otherId), direction };
  });

  const formatDate = (ts: number) => new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });

  return (
    <div className="h-full rounded-lg bg-gray-900/90 border border-gray-700/50 backdrop-blur-sm shadow-xl flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700/50">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: color }} />
          <span className="text-sm font-medium text-gray-200">
            {CATEGORY_LABELS[memory.category] || memory.category}
          </span>
        </div>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700/50 transition-colors"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* Memory content */}
        <p className="text-sm text-gray-300 leading-relaxed">{memory.content}</p>

        {/* Metadata grid */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-gray-800/50 rounded px-2.5 py-1.5">
            <div className="text-gray-500 mb-0.5">Importance</div>
            <div className="text-gray-300 font-medium">{memory.importance}/10</div>
          </div>
          <div className="bg-gray-800/50 rounded px-2.5 py-1.5">
            <div className="text-gray-500 mb-0.5">Prominence</div>
            <div className="text-gray-300 font-medium">{(memory.prominence * 100).toFixed(0)}%</div>
          </div>
          <div className="bg-gray-800/50 rounded px-2.5 py-1.5">
            <div className="text-gray-500 mb-0.5">Confidence</div>
            <div className="text-gray-300 font-medium">{(memory.confidence * 100).toFixed(0)}%</div>
          </div>
          <div className="bg-gray-800/50 rounded px-2.5 py-1.5">
            <div className="text-gray-500 mb-0.5">Accesses</div>
            <div className="text-gray-300 font-medium">{memory.accessCount}</div>
          </div>
          <div className="bg-gray-800/50 rounded px-2.5 py-1.5">
            <div className="text-gray-500 mb-0.5">Type</div>
            <div className="text-gray-300 font-medium">{memory.memoryType}</div>
          </div>
          <div className="bg-gray-800/50 rounded px-2.5 py-1.5">
            <div className="text-gray-500 mb-0.5">Embedding</div>
            <div className="text-gray-300 font-medium">{memory.hasEmbedding ? 'Yes' : 'No'}</div>
          </div>
        </div>

        {/* Dates */}
        <div className="text-xs text-gray-500 space-y-1">
          <div>Created: {formatDate(memory.createdAt)}</div>
          <div>Updated: {formatDate(memory.updatedAt)}</div>
        </div>

        {/* Relations */}
        {relatedNodes.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-gray-400 mb-2">Relations ({relatedNodes.length})</h4>
            <div className="space-y-1.5">
              {relatedNodes.map(({ edge, other, direction }, i) => (
                <div key={i} className="flex items-center gap-2 text-xs bg-gray-800/40 rounded px-2.5 py-1.5">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: RELATION_COLORS[edge.relationType] || '#6b7280' }}
                  />
                  <span className="text-gray-500">{direction === 'outgoing' ? '\u2192' : '\u2190'}</span>
                  <span className="text-gray-400">{edge.relationType}</span>
                  <span className="text-gray-500 truncate flex-1">
                    {other ? other.memory.content.slice(0, 50) + '...' : 'Unknown'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
