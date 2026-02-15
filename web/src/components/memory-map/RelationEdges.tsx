import { useRef, useMemo, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { ProcessedEdge } from './types';

interface RelationEdgesProps {
  edges: ProcessedEdge[];
  highlightIds: Record<string, true> | null;
  darkMode: boolean;
}

/** A single batch of fat line segments that fades in and can be dimmed */
function EdgeBatch({ positions, color, targetOpacity }: {
  positions: Float32Array;
  color: string;
  targetOpacity: number;
}) {
  const spawnTime = useRef(-1);
  const { size } = useThree();

  const { lineObj, mat } = useMemo(() => {
    const geom = new LineSegmentsGeometry();
    geom.setPositions(Array.from(positions));
    const m = new LineMaterial({
      color: new THREE.Color(color).getHex(),
      linewidth: 2,
      transparent: true,
      opacity: 0.01,
    });
    const l = new LineSegments2(geom, m);
    return { lineObj: l, mat: m };
  }, [positions, color]);

  // Keep resolution in sync so linewidth is in pixels
  useEffect(() => {
    mat.resolution.set(size.width, size.height);
  }, [mat, size]);

  // Dispose old geometry/material when batch changes or unmounts
  useEffect(() => {
    return () => {
      lineObj.geometry.dispose();
      mat.dispose();
    };
  }, [lineObj, mat]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (spawnTime.current < 0) spawnTime.current = t;
    const age = t - spawnTime.current;
    const eased = Math.min(1, 1 - Math.pow(Math.max(0, 1 - age / 0.8), 3));
    const goal = targetOpacity * eased;
    mat.opacity += (goal - mat.opacity) * 0.1;
  });

  return <primitive object={lineObj} />;
}

export default function RelationEdges({ edges, highlightIds, darkMode }: RelationEdgesProps) {
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
      targetOpacity: g.dimmed ? 0.04 : darkMode ? 0.7 : 0.9,
    }));
  }, [edges, highlightIds, darkMode]);

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
