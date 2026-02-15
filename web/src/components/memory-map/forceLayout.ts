import type { MemoryNode, MemoryEdge } from '../../hooks/useMemoryGraph';

/**
 * 3D force-directed graph layout.
 *
 * - Connected nodes attract strongly (spring force)
 * - Same-category nodes attract gently (soft clustering)
 * - All nodes repel (prevent overlap)
 * - High-importance nodes are heavier (move less, anchor clusters)
 * - Seeded RNG for deterministic layout across refreshes
 */
export function computeForceLayout(
  memories: MemoryNode[],
  relations: MemoryEdge[],
): Record<string, [number, number, number]> {
  const n = memories.length;
  if (n === 0) return {};

  // Seeded pseudo-random for deterministic layout
  let seed = 42;
  const rand = () => {
    seed = (seed * 16807 + 0) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  const idToIdx = new Map<string, number>();
  memories.forEach((m, i) => idToIdx.set(m.id, i));

  // Build adjacency set for quick lookup
  const connected = new Set<string>();
  for (const rel of relations) {
    const si = idToIdx.get(rel.sourceId);
    const ti = idToIdx.get(rel.targetId);
    if (si !== undefined && ti !== undefined) {
      connected.add(`${si}:${ti}`);
      connected.add(`${ti}:${si}`);
    }
  }

  // Group by category — place centers in 3D (not just a flat ring)
  const categories = [...new Set(memories.map(m => m.category))];
  const catCenter: Record<string, [number, number, number]> = {};
  categories.forEach((cat, i) => {
    // Spread on a sphere for 3D separation
    const golden = (1 + Math.sqrt(5)) / 2;
    const theta = (2 * Math.PI * i) / golden;
    const phi = Math.acos(1 - (2 * (i + 0.5)) / categories.length);
    const r = 6;
    catCenter[cat] = [
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.sin(phi) * Math.sin(theta),
      r * Math.cos(phi),
    ];
  });

  // Initialize positions near category centers with small jitter
  const pos: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const c = catCenter[memories[i].category];
    pos.push([
      c[0] + (rand() - 0.5) * 2.5,
      c[1] + (rand() - 0.5) * 2.5,
      c[2] + (rand() - 0.5) * 2.5,
    ]);
  }

  // Mass: higher importance = heavier = more stable anchor
  const mass: number[] = memories.map(m => 0.5 + (m.importance / 10) * 1.5);

  const vel: [number, number, number][] = Array.from({ length: n }, () => [0, 0, 0]);

  const ITERATIONS = 200;
  const EDGE_SPRING = 0.15;       // connected nodes pull together
  const IDEAL_EDGE_LEN = 1.8;     // target distance for connected pairs
  const CATEGORY_PULL = 0.008;    // same-category soft attraction
  const REPULSION = 3.0;          // all-pairs repulsion
  const CENTER_PULL = 0.003;      // keep graph centered
  const DAMPING = 0.88;
  const MIN_DIST = 0.2;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const temp = Math.max(0.05, 1 - (iter / ITERATIONS) * 0.9); // cooling with floor

    // Repulsive forces (all pairs — Coulomb)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[i][0] - pos[j][0];
        const dy = pos[i][1] - pos[j][1];
        const dz = pos[i][2] - pos[j][2];
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), MIN_DIST);
        const force = (REPULSION * temp) / (dist * dist);
        const nx = dx / dist, ny = dy / dist, nz = dz / dist;
        const fi = force / mass[i], fj = force / mass[j];
        vel[i][0] += nx * fi; vel[i][1] += ny * fi; vel[i][2] += nz * fi;
        vel[j][0] -= nx * fj; vel[j][1] -= ny * fj; vel[j][2] -= nz * fj;
      }
    }

    // Attractive forces (edges — spring toward ideal length)
    for (const rel of relations) {
      const si = idToIdx.get(rel.sourceId);
      const ti = idToIdx.get(rel.targetId);
      if (si === undefined || ti === undefined) continue;
      const dx = pos[si][0] - pos[ti][0];
      const dy = pos[si][1] - pos[ti][1];
      const dz = pos[si][2] - pos[ti][2];
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), MIN_DIST);
      // Spring: pull if > ideal, push slightly if < ideal
      const displacement = dist - IDEAL_EDGE_LEN;
      const force = EDGE_SPRING * displacement * temp;
      const nx = dx / dist, ny = dy / dist, nz = dz / dist;
      vel[si][0] -= nx * force / mass[si];
      vel[si][1] -= ny * force / mass[si];
      vel[si][2] -= nz * force / mass[si];
      vel[ti][0] += nx * force / mass[ti];
      vel[ti][1] += ny * force / mass[ti];
      vel[ti][2] += nz * force / mass[ti];
    }

    // Same-category soft attraction (pull toward category neighbors' centroid)
    for (let i = 0; i < n; i++) {
      const c = catCenter[memories[i].category];
      vel[i][0] += (c[0] - pos[i][0]) * CATEGORY_PULL * temp;
      vel[i][1] += (c[1] - pos[i][1]) * CATEGORY_PULL * temp;
      vel[i][2] += (c[2] - pos[i][2]) * CATEGORY_PULL * temp;
    }

    // Center pull + update
    for (let i = 0; i < n; i++) {
      vel[i][0] -= pos[i][0] * CENTER_PULL;
      vel[i][1] -= pos[i][1] * CENTER_PULL;
      vel[i][2] -= pos[i][2] * CENTER_PULL;
      vel[i][0] *= DAMPING; vel[i][1] *= DAMPING; vel[i][2] *= DAMPING;
      pos[i][0] += vel[i][0];
      pos[i][1] += vel[i][1];
      pos[i][2] += vel[i][2];
    }

    // Update category centers to actual centroid of their members (dynamic)
    if (iter % 10 === 0) {
      const counts: Record<string, number> = {};
      const sums: Record<string, [number, number, number]> = {};
      for (const cat of categories) { counts[cat] = 0; sums[cat] = [0, 0, 0]; }
      for (let i = 0; i < n; i++) {
        const cat = memories[i].category;
        counts[cat]++;
        sums[cat][0] += pos[i][0];
        sums[cat][1] += pos[i][1];
        sums[cat][2] += pos[i][2];
      }
      for (const cat of categories) {
        if (counts[cat] > 0) {
          catCenter[cat] = [
            sums[cat][0] / counts[cat],
            sums[cat][1] / counts[cat],
            sums[cat][2] / counts[cat],
          ];
        }
      }
    }
  }

  // Normalize to radius 10
  let maxR = 0;
  for (const p of pos) {
    const r = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
    if (r > maxR) maxR = r;
  }
  const scale = maxR > 0 ? 10 / maxR : 1;

  const result: Record<string, [number, number, number]> = {};
  for (let i = 0; i < n; i++) {
    result[memories[i].id] = [
      pos[i][0] * scale,
      pos[i][1] * scale,
      pos[i][2] * scale,
    ];
  }
  return result;
}
