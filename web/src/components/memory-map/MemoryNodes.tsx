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
  highlightIds: Record<string, true> | null;
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
  const ref = useRef<THREE.Mesh>(null!);
  const spawnTime = useRef(-1);

  const baseScale = isSelected ? node.size * 1.6 : isHovered ? node.size * 1.4 : node.size;
  const displayColor = showColor ? node.color : '#ffffff';
  const emissiveIntensity = isHovered || isSelected ? 1.2 : 0.4 + node.opacity * 0.6;
  const targetOpacity = dimmed ? 0.06 : node.opacity;
  const targetEmissive = dimmed ? 0.05 : emissiveIntensity;

  useFrame(({ clock }) => {
    const mesh = ref.current;
    if (!mesh) return;
    const t = clock.getElapsedTime();

    // Entrance animation
    if (spawnTime.current < 0) spawnTime.current = t;
    const age = t - spawnTime.current;
    const eased = Math.min(1, 1 - Math.pow(Math.max(0, 1 - age / 0.6), 3));

    // Float
    const floatY = Math.sin(t * 0.5 + node.index * 0.7) * 0.15;
    mesh.position.set(node.position[0], node.position[1] + floatY, node.position[2]);

    // Smooth scale
    const goalScale = baseScale * eased;
    const s = mesh.scale.x;
    const newS = s + (goalScale - s) * 0.12;
    mesh.scale.setScalar(newS);

    // Smooth material
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.opacity += (targetOpacity * eased - mat.opacity) * 0.12;
    mat.emissiveIntensity += (targetEmissive * eased - mat.emissiveIntensity) * 0.12;
  });

  return (
    <mesh
      ref={ref}
      scale={[0.001, 0.001, 0.001]}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(node.index); }}
      onPointerOut={() => onHover(null)}
      onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSelect(node.index); }}
    >
      <sphereGeometry args={[1, 16, 16]} />
      <meshStandardMaterial
        color={displayColor}
        emissive={displayColor}
        emissiveIntensity={0}
        transparent
        opacity={0.01}
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
          const dimmed = highlightIds !== null && !highlightIds[node.memory.id];
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
