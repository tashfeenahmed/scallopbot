import { useMemo } from 'react';
import * as THREE from 'three';
import type { ProcessedEdge } from './types';

interface RelationEdgesProps {
  edges: ProcessedEdge[];
}

export default function RelationEdges({ edges }: RelationEdgesProps) {
  // Group edges by relation type for color batching
  const groups = useMemo(() => {
    const map = new Map<string, { color: string; positions: number[] }>();
    for (const edge of edges) {
      let group = map.get(edge.relationType);
      if (!group) {
        group = { color: edge.color, positions: [] };
        map.set(edge.relationType, group);
      }
      group.positions.push(
        edge.source[0], edge.source[1], edge.source[2],
        edge.target[0], edge.target[1], edge.target[2]
      );
    }
    return Array.from(map.values());
  }, [edges]);

  return (
    <group>
      {groups.map((group, i) => (
        <lineSegments key={i}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[new Float32Array(group.positions), 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial color={group.color} transparent opacity={0.7} />
        </lineSegments>
      ))}
    </group>
  );
}
