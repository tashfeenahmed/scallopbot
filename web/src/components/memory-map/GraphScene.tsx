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
  hoveredCategory: string | null;
  allCategoriesActive: boolean;
  highlightIds: Record<string, true> | null;
  onHover: (index: number | null) => void;
  onSelect: (index: number | null) => void;
  darkMode: boolean;
}

export default function GraphScene({ nodes, edges, hoveredIndex, selectedIndex, hoveredCategory, allCategoriesActive, highlightIds, onHover, onSelect, darkMode }: GraphSceneProps) {
  return (
    <Canvas
      camera={{ position: [0, 0, 25], fov: 60 }}
      style={{ background: darkMode ? '#030712' : '#e8eaed' }}
      gl={{ antialias: true }}
    >
      <ambientLight intensity={darkMode ? 0.3 : 0.8} />
      <pointLight position={[20, 15, 10]} intensity={darkMode ? 0.8 : 0.5} color={darkMode ? '#60a5fa' : '#94a3b8'} />
      <pointLight position={[-20, -15, -10]} intensity={darkMode ? 0.5 : 0.3} color={darkMode ? '#a78bfa' : '#94a3b8'} />

      {darkMode && <Stars radius={80} depth={60} count={1500} factor={3} saturation={0.2} fade speed={0.5} />}

      <MemoryNodes
        nodes={nodes}
        hoveredIndex={hoveredIndex}
        selectedIndex={selectedIndex}
        hoveredCategory={hoveredCategory}
        allCategoriesActive={allCategoriesActive}
        highlightIds={highlightIds}
        onHover={onHover}
        onSelect={onSelect}
        darkMode={darkMode}
      />
      <RelationEdges edges={edges} highlightIds={highlightIds} darkMode={darkMode} />
      <AmbientParticles darkMode={darkMode} />

      <OrbitControls enableDamping dampingFactor={0.05} minDistance={5} maxDistance={60} />

      {darkMode ? (
        <EffectComposer>
          <Bloom intensity={1.5} luminanceThreshold={0.2} luminanceSmoothing={0.9} mipmapBlur />
          <Vignette offset={0.3} darkness={0.7} />
        </EffectComposer>
      ) : (
        <EffectComposer>
          <Bloom intensity={0.3} luminanceThreshold={0.6} luminanceSmoothing={0.9} mipmapBlur />
          <Vignette offset={0.3} darkness={0.15} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
