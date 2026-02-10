import { Canvas } from '@react-three/fiber';
import { OrbitControls, Stars } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import type { ProcessedNode, ProcessedEdge } from './types';
import MemoryNodes from './MemoryNodes';
import RelationEdges from './RelationEdges';
import AmbientParticles from './AmbientParticles';

interface GraphSceneProps {
  nodes: ProcessedNode[];
  edges: ProcessedEdge[];
  hoveredIndex: number | null;
  selectedIndex: number | null;
  onHover: (index: number | null) => void;
  onSelect: (index: number | null) => void;
}

export default function GraphScene({ nodes, edges, hoveredIndex, selectedIndex, onHover, onSelect }: GraphSceneProps) {
  return (
    <Canvas
      camera={{ position: [0, 0, 25], fov: 60 }}
      style={{ background: '#030712' }}
      gl={{ antialias: true }}
    >
      <ambientLight intensity={0.3} />
      <pointLight position={[20, 15, 10]} intensity={0.8} color="#60a5fa" />
      <pointLight position={[-20, -15, -10]} intensity={0.5} color="#a78bfa" />

      <Stars radius={80} depth={60} count={1500} factor={3} saturation={0.2} fade speed={0.5} />

      <MemoryNodes
        nodes={nodes}
        hoveredIndex={hoveredIndex}
        selectedIndex={selectedIndex}
        onHover={onHover}
        onSelect={onSelect}
      />
      <RelationEdges edges={edges} />
      <AmbientParticles />

      <OrbitControls enableDamping dampingFactor={0.05} minDistance={5} maxDistance={60} />

      <EffectComposer>
        <Bloom intensity={1.5} luminanceThreshold={0.2} luminanceSmoothing={0.9} mipmapBlur />
        <Vignette offset={0.3} darkness={0.7} />
      </EffectComposer>
    </Canvas>
  );
}
