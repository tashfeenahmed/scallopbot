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
  onHover: (index: number | null) => void;
  onSelect: (index: number | null) => void;
}

const _vec = new THREE.Vector3();

function MemoryNode({
  node,
  isHovered,
  isSelected,
  showColor,
  onHover,
  onSelect,
}: {
  node: ProcessedNode;
  isHovered: boolean;
  isSelected: boolean;
  showColor: boolean;
  onHover: (index: number | null) => void;
  onSelect: (index: number | null) => void;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const baseScale = isSelected ? node.size * 1.6 : isHovered ? node.size * 1.4 : node.size;
  const displayColor = showColor ? node.color : '#ffffff';
  // Glow intensity scales with opacity so bright nodes glow more
  const emissiveIntensity = isHovered || isSelected ? 1.2 : 0.4 + node.opacity * 0.6;

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    const floatY = Math.sin(t * 0.5 + node.index * 0.7) * 0.15;
    ref.current.position.set(node.position[0], node.position[1] + floatY, node.position[2]);
  });

  return (
    <mesh
      ref={ref}
      scale={baseScale}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(node.index); }}
      onPointerOut={() => onHover(null)}
      onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSelect(node.index); }}
    >
      <sphereGeometry args={[1, 16, 16]} />
      <meshStandardMaterial
        color={displayColor}
        emissive={displayColor}
        emissiveIntensity={emissiveIntensity}
        transparent
        opacity={node.opacity}
        toneMapped={false}
        depthWrite={node.opacity > 0.5}
      />
    </mesh>
  );
}

export default function MemoryNodes({ nodes, hoveredIndex, selectedIndex, hoveredCategory, allCategoriesActive, onHover, onSelect }: MemoryNodesProps) {
  return (
    <group>
      {nodes.map(
        (node) => {
          if (!node.visible) return null;
          const isHovered = node.index === hoveredIndex;
          const isSelected = node.index === selectedIndex;
          // Show color when: hovered, selected, category hovered in filter bar, or any category is filtered out
          const showColor = isHovered || isSelected || hoveredCategory === node.memory.category || !allCategoriesActive;
          return (
            <MemoryNode
              key={node.memory.id}
              node={node}
              isHovered={isHovered}
              isSelected={isSelected}
              showColor={showColor}
              onHover={onHover}
              onSelect={onSelect}
            />
          );
        }
      )}
    </group>
  );
}
