import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const PARTICLE_COUNT = 200;

interface AmbientParticlesProps {
  darkMode: boolean;
}

export default function AmbientParticles({ darkMode }: AmbientParticlesProps) {
  const ref = useRef<THREE.Points>(null);

  const positions = useMemo(() => {
    const arr = new Float32Array(PARTICLE_COUNT * 3);
    for (let i = 0; i < PARTICLE_COUNT * 3; i++) {
      arr[i] = (Math.random() - 0.5) * 40;
    }
    return arr;
  }, []);

  useFrame(({ clock }) => {
    if (ref.current) {
      ref.current.rotation.y = clock.getElapsedTime() * 0.02;
      ref.current.rotation.x = Math.sin(clock.getElapsedTime() * 0.01) * 0.1;
    }
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.05} color={darkMode ? '#60a5fa' : '#94a3b8'} transparent opacity={darkMode ? 0.3 : 0.15} sizeAttenuation />
    </points>
  );
}
