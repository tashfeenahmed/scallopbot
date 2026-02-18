/**
 * PCA projection utility for 3D memory map visualization.
 *
 * Uses power iteration with Gram-Schmidt orthogonalization to find the
 * top 3 principal components, then projects embeddings into 3D space.
 */

/**
 * Project high-dimensional embeddings to 3D positions via PCA.
 *
 * @param embeddingMap - Map of id → embedding vector
 * @param allIds - All IDs that need positions (including those without embeddings)
 * @returns Position map: id → [x, y, z]
 */
export function projectTo3D(
  embeddingMap: Map<string, number[]>,
  allIds: string[],
): Record<string, [number, number, number]> {
  const positions: Record<string, [number, number, number]> = {};

  if (embeddingMap.size < 3) {
    // Not enough embeddings for PCA — place all on a sphere
    for (const id of allIds) {
      positions[id] = randomSpherePoint(4, 10);
    }
    return positions;
  }

  const ids = Array.from(embeddingMap.keys());
  const dim = embeddingMap.get(ids[0])!.length;
  const n = ids.length;

  // Build matrix and compute mean
  const mean = new Float64Array(dim);
  const matrix: Float64Array[] = [];
  for (const id of ids) {
    const vec = new Float64Array(embeddingMap.get(id)!);
    matrix.push(vec);
    for (let j = 0; j < dim; j++) mean[j] += vec[j];
  }
  for (let j = 0; j < dim; j++) mean[j] /= n;

  // Center data
  for (const vec of matrix) {
    for (let j = 0; j < dim; j++) vec[j] -= mean[j];
  }

  // Power iteration for top 3 principal components
  const components: Float64Array[] = [];
  for (let comp = 0; comp < 3; comp++) {
    let v = new Float64Array(dim);
    for (let j = 0; j < dim; j++) v[j] = Math.random() - 0.5;

    for (let iter = 0; iter < 50; iter++) {
      // Compute X^T * X * v
      const newV = new Float64Array(dim);
      for (const row of matrix) {
        let dot = 0;
        for (let j = 0; j < dim; j++) dot += row[j] * v[j];
        for (let j = 0; j < dim; j++) newV[j] += dot * row[j];
      }

      // Gram-Schmidt orthogonalization against previous components
      for (const prev of components) {
        let dot = 0;
        for (let j = 0; j < dim; j++) dot += newV[j] * prev[j];
        for (let j = 0; j < dim; j++) newV[j] -= dot * prev[j];
      }

      // Normalize
      let norm = 0;
      for (let j = 0; j < dim; j++) norm += newV[j] * newV[j];
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let j = 0; j < dim; j++) newV[j] /= norm;
      }
      v = newV;
    }
    components.push(v);
  }

  // Project data onto 3 components
  const projected: [number, number, number][] = [];
  for (const row of matrix) {
    const p: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      let dot = 0;
      for (let j = 0; j < dim; j++) dot += row[j] * components[c][j];
      p[c] = dot;
    }
    projected.push(p);
  }

  // Uniform normalization: use the single largest axis range so
  // proportions are preserved (avoids stretching into a cube)
  let globalMax = 0;
  for (let c = 0; c < 3; c++) {
    for (const p of projected) {
      const abs = Math.abs(p[c]);
      if (abs > globalMax) globalMax = abs;
    }
  }
  const scale = globalMax > 0 ? 10 / globalMax : 1;
  for (const p of projected) {
    p[0] *= scale;
    p[1] *= scale;
    p[2] *= scale;
  }

  // Build positions for embedded IDs
  for (let i = 0; i < ids.length; i++) {
    positions[ids[i]] = projected[i];
  }

  // Assign random positions on outer shell for IDs without embeddings
  for (const id of allIds) {
    if (!positions[id]) {
      positions[id] = randomSpherePoint(8, 10);
    }
  }

  return positions;
}

/** Random point on a sphere with radius between rMin and rMax */
function randomSpherePoint(rMin: number, rMax: number): [number, number, number] {
  const theta = Math.random() * 2 * Math.PI;
  const phi = Math.acos(2 * Math.random() - 1);
  const r = rMin + Math.random() * (rMax - rMin);
  return [
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.sin(phi) * Math.sin(theta),
    r * Math.cos(phi),
  ];
}
