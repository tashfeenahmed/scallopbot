import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { ProcessedEdge } from './types';

interface RelationEdgesProps {
  edges: ProcessedEdge[];
  highlightIds: Record<string, true> | null;
}

/** A single batch of line segments that fades in and can be dimmed */
function EdgeBatch({ positions, color, targetOpacity }: {
  positions: Float32Array;
  color: string;
  targetOpacity: number;
}) {
  const matRef = useRef<THREE.LineBasicMaterial>(null!);
  const spawnTime = useRef(-1);

  const geometry = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geom;
  }, [positions]);

  useFrame(({ clock }) => {
    const mat = matRef.current;
    if (!mat) return;
    const t = clock.getElapsedTime();

    if (spawnTime.current < 0) spawnTime.current = t;
    const age = t - spawnTime.current;
    const eased = Math.min(1, 1 - Math.pow(Math.max(0, 1 - age / 0.8), 3));

    const goal = targetOpacity * eased;
    mat.opacity += (goal - mat.opacity) * 0.1;
  });

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial ref={matRef} color={color} transparent opacity={0.01} />
    </lineSegments>
  );
}

export default function RelationEdges({ edges, highlightIds }: RelationEdgesProps) {
  // Group edges by: relationType + dimmed state
  const batches = useMemo(() => {
    const map = new Map<string, { color: string; positions: number[]; dimmed: boolean }>();

    for (const edge of edges) {
      const dimmed = highlightIds !== null &&
        !highlightIds[edge.relation.sourceId] &&
        !highlightIds[edge.relation.targetId];
      const key = `${edge.relationType}:${dimmed ? 'd' : 'h'}`;

      let group = map.get(key);
      if (!group) {
        group = { color: edge.color, positions: [], dimmed };
        map.set(key, group);
      }
      group.positions.push(
        edge.source[0], edge.source[1], edge.source[2],
        edge.target[0], edge.target[1], edge.target[2],
      );
    }

    return Array.from(map.entries()).map(([key, g]) => ({
      key,
      color: g.color,
      positions: new Float32Array(g.positions),
      targetOpacity: g.dimmed ? 0.04 : 0.7,
    }));
  }, [edges, highlightIds]);

  return (
    <group>
      {batches.map((b) => (
        <EdgeBatch
          key={b.key}
          positions={b.positions}
          color={b.color}
          targetOpacity={b.targetOpacity}
        />
      ))}
    </group>
  );
}
