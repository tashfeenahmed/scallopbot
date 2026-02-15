import { useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { ProcessedNode } from './types';

interface MemoryNodesProps {
  nodes: ProcessedNode[];
  hoveredIndex: number | null;
  selectedIndex: number | null;
  hoveredCategory: string | null;
  allCategoriesActive: boolean;
  highlightIds: Set<string> | null;
  onHover: (index: number | null) => void;
  onSelect: (index: number | null) => void;
}

function MemoryNode({
  node,
  isHovered,
  isSelected,
  showColor,
  dimmed,
  onHover,
  onSelect,
}: {
  node: ProcessedNode;
  isHovered: boolean;
  isSelected: boolean;
  showColor: boolean;
  dimmed: boolean;
  onHover: (index: number | null) => void;
  onSelect: (index: number | null) => void;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshStandardMaterial>(null);
  // Track entrance animation progress (0 → 1)
  const entranceRef = useRef(0);
  const spawnTime = useRef(-1);

  const baseScale = isSelected ? node.size * 1.6 : isHovered ? node.size * 1.4 : node.size;
  const displayColor = showColor ? node.color : '#ffffff';
  const emissiveIntensity = isHovered || isSelected ? 1.2 : 0.4 + node.opacity * 0.6;

  // Target opacity: dim to 0.06 when another node is hovered and this isn't a neighbor
  const targetOpacity = dimmed ? 0.06 : node.opacity;
  const targetEmissive = dimmed ? 0.05 : emissiveIntensity;

  useFrame(({ clock }) => {
    if (!ref.current || !matRef.current) return;
    const t = clock.getElapsedTime();

    // Entrance animation: scale from 0 over 0.6s with ease-out
    if (spawnTime.current < 0) spawnTime.current = t;
    const age = t - spawnTime.current;
    const entrance = Math.min(age / 0.6, 1);
    // ease-out cubic
    const eased = 1 - Math.pow(1 - entrance, 3);
    entranceRef.current = eased;

    const floatY = Math.sin(t * 0.5 + node.index * 0.7) * 0.15;
    ref.current.position.set(node.position[0], node.position[1] + floatY, node.position[2]);

    // Smoothly lerp scale and opacity
    const currentScale = ref.current.scale.x;
    const goalScale = baseScale * eased;
    const lerpedScale = THREE.MathUtils.lerp(currentScale, goalScale, 0.12);
    ref.current.scale.setScalar(lerpedScale);

    const currentOpacity = matRef.current.opacity;
    const goalOpacity = targetOpacity * eased;
    matRef.current.opacity = THREE.MathUtils.lerp(currentOpacity, goalOpacity, 0.12);
    matRef.current.emissiveIntensity = THREE.MathUtils.lerp(
      matRef.current.emissiveIntensity,
      targetEmissive * eased,
      0.12
    );
  });

  return (
    <mesh
      ref={ref}
      scale={0}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(node.index); }}
      onPointerOut={() => onHover(null)}
      onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSelect(node.index); }}
    >
      <sphereGeometry args={[1, 16, 16]} />
      <meshStandardMaterial
        ref={matRef}
        color={displayColor}
        emissive={displayColor}
        emissiveIntensity={0}
        transparent
        opacity={0}
        toneMapped={false}
        depthWrite={node.opacity > 0.5}
      />
    </mesh>
  );
}

export default function MemoryNodes({ nodes, hoveredIndex, selectedIndex, hoveredCategory, allCategoriesActive, highlightIds, onHover, onSelect }: MemoryNodesProps) {
  return (
    <group>
      {nodes.map(
        (node) => {
          if (!node.visible) return null;
          const isHovered = node.index === hoveredIndex;
          const isSelected = node.index === selectedIndex;
          const showColor = isHovered || isSelected || hoveredCategory === node.memory.category || !allCategoriesActive;
          // Dim nodes not in the highlight set (when hovering)
          const dimmed = highlightIds !== null && !highlightIds.has(node.memory.id);
          return (
            <MemoryNode
              key={node.memory.id}
              node={node}
              isHovered={isHovered}
              isSelected={isSelected}
              showColor={showColor}
              dimmed={dimmed}
              onHover={onHover}
              onSelect={onSelect}
            />
          );
        }
      )}
    </group>
  );
}
