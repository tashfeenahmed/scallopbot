# Phase 20: Spreading Activation - Research

**Researched:** 2026-02-10
**Domain:** Cognitive-science-inspired activation propagation for memory graph retrieval
**Confidence:** HIGH

<research_summary>
## Summary

Researched ACT-R cognitive architecture activation formulas, the SYNAPSE paper (Jan 2026) on spreading activation for AI agent memory, and practical implementation patterns for graph-based activation propagation. The goal is to replace the current BFS traversal in `getRelatedMemoriesForContext` (relations.ts:526) with scored, decay-weighted activation propagation plus stochastic noise.

The standard approach uses synchronous spreading activation with 3 timesteps, multiplicative hop decay (factor 0.5), typed edge weights (UPDATES=0.9, EXTENDS=0.7, DERIVES=0.5), fan-out normalization to prevent hub dominance, and Gaussian noise for retrieval diversity. The SYNAPSE paper provides the most complete reference implementation with lateral inhibition and sigmoid gating, but we can use a simpler variant since our graph is smaller and edge types already carry semantic meaning.

Key finding: The current BFS returns *all* reachable memories without scoring — activation propagation naturally produces relevance scores that decay with graph distance, enabling ranked retrieval of related memories.

**Primary recommendation:** Implement synchronous spreading activation with 3 timesteps, decay factor 0.5, typed edge weights scaled by confidence, fan-out normalization, and configurable Gaussian noise (sigma=0.2). Return memories sorted by activation score rather than unranked BFS results.
</research_summary>

<standard_stack>
## Standard Stack

No external libraries needed — this is a pure algorithmic change to the existing `RelationGraph` class. All formulas are implementable in TypeScript with no dependencies.

### Core Formulas

| Formula | Source | Purpose | Why Standard |
|---------|--------|---------|--------------|
| ACT-R Base-Level Activation | Anderson & Lebiere 1998 | `B_i = ln(Σ t_j^(-d))` — memory strength from access history | 40+ years of cognitive science validation |
| Spreading Activation Propagation | SYNAPSE (2026) / spreadr | `a_j += a_i * w_ij * decay / fan(i)` — activation flow through edges | Standard in both cognitive science and knowledge graph retrieval |
| Sigmoid Gating | SYNAPSE (2026) | `σ(x) = 1/(1 + exp(-γ(x - θ)))` — firing threshold | Controls which nodes propagate (prevents noise amplification) |
| Logistic/Gaussian Noise | ACT-R / W3C CogAI | Stochastic perturbation of activation levels | Prevents deterministic retrieval (same query always same results) |

### Supporting Concepts

| Concept | Source | Purpose | When to Use |
|---------|--------|---------|-------------|
| Fan-out Normalization | spreadr / SYNAPSE | Divide outgoing activation by node degree | Always — prevents hub dominance |
| Lateral Inhibition | SYNAPSE (2026) | Top-M nodes suppress weaker activations | Optional — useful if graph grows large (>1000 nodes) |
| PPR-style Restart | Personalized PageRank | Re-inject seed activation each step | Optional — useful if propagation drifts from query context |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Spreading activation | Personalized PageRank | PPR is mathematically equivalent with specific decay schedule; spreading activation is more natural for typed edges and multiple seed nodes |
| Spreading activation | Random Walk with Restart | RWR is a simulation approach; spreading activation is deterministic per timestep (more predictable) |
| Fixed 3 steps | Delta convergence | Convergence detection adds complexity; 3 steps sufficient for depth-2 equivalent propagation |
| Gaussian noise | Logistic noise (ACT-R) | Logistic has heavier tails (more extreme values); Gaussian is simpler and sufficient for diversity |

### No Installation Needed

This is a pure algorithm change within the existing `RelationGraph` class. No new packages required.
</standard_stack>

<architecture_patterns>
## Architecture Patterns

### Current vs. New Architecture

```
CURRENT (BFS):
search() → topResults → getRelatedMemoriesForContext(id, maxDepth=2)
                         └── BFS traverse → collect all reachable isLatest memories (unranked)

NEW (Spreading Activation):
search() → topResults → getRelatedMemoriesWithActivation(id, config)
                         └── Seed node → 3-step propagation → scored memories (ranked)
```

### Pattern 1: Synchronous Spreading Activation

**What:** Fire all active nodes simultaneously at each timestep. New activations computed from previous timestep's values (double-buffering). This avoids order-dependent results.

**When to use:** Always — this is the standard approach.

**Algorithm (pseudocode):**
```typescript
// Source: spreadr (Behavior Research Methods), SYNAPSE (arXiv 2601.02744)
function spreadActivation(seedId: string, config: ActivationConfig): ActivatedMemory[] {
  const activation = new Map<string, number>();  // current activations
  activation.set(seedId, 1.0);                   // seed node starts at 1.0

  for (let step = 0; step < config.maxSteps; step++) {
    const newActivation = new Map<string, number>();

    // Copy current activations (retention)
    for (const [id, value] of activation) {
      newActivation.set(id, (newActivation.get(id) ?? 0) + value * config.retention);
    }

    // Propagate from each active node
    for (const [id, value] of activation) {
      if (value < config.activationThreshold) continue;

      const relations = db.getRelations(id);
      const outDegree = relations.length;
      if (outDegree === 0) continue;

      for (const rel of relations) {
        const neighborId = rel.sourceId === id ? rel.targetId : rel.sourceId;
        const edgeWeight = getEdgeWeight(rel, id);
        const spread = value * edgeWeight * config.decayFactor / outDegree;

        newActivation.set(neighborId,
          Math.min(1.0, (newActivation.get(neighborId) ?? 0) + spread));
      }
    }

    // Replace old activations with new
    activation.clear();
    for (const [id, value] of newActivation) {
      if (value >= config.activationThreshold) {
        activation.set(id, value);
      }
    }
  }

  // Remove seed node, add noise, filter by prominence
  activation.delete(seedId);
  return buildResults(activation, config.noiseSigma);
}
```

### Pattern 2: Typed Edge Weights

**What:** Different relation types propagate activation with different strengths, and direction matters.

**When to use:** Always — our edges carry semantic meaning.

```typescript
// Source: Adapted from SYNAPSE edge weighting + domain semantics
const EDGE_WEIGHTS: Record<RelationType, { forward: number; reverse: number }> = {
  UPDATES:  { forward: 0.9, reverse: 0.9 },  // bidirectional strong link
  EXTENDS:  { forward: 0.7, reverse: 0.5 },  // extension is more informative than base
  DERIVES:  { forward: 0.4, reverse: 0.6 },  // sources are more relevant than derivations
};

function getEdgeWeight(relation: MemoryRelation, fromId: string): number {
  const weights = EDGE_WEIGHTS[relation.relationType];
  const isForward = relation.sourceId === fromId;
  const directionWeight = isForward ? weights.forward : weights.reverse;
  return directionWeight * relation.confidence;
}
```

### Pattern 3: Gaussian Noise for Retrieval Diversity

**What:** Add multiplicative noise to final activation scores so repeated queries don't always return identical results.

**When to use:** At the final scoring step, before ranking.

```typescript
// Source: W3C CogAI spec, Box-Muller transform
function gaussianNoise(sigma: number): number {
  if (sigma === 0) return 0;
  const u1 = Math.random();
  const u2 = Math.random();
  return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Apply multiplicatively in log-space
function addNoise(activation: number, sigma: number): number {
  return activation * Math.exp(gaussianNoise(sigma));
}
```

### Anti-Patterns to Avoid

- **Asynchronous propagation:** Firing nodes one-at-a-time creates order-dependent results. Use synchronous (double-buffered) propagation.
- **No fan-out normalization:** Without dividing by degree, hub nodes amplify activation causing explosion. Always normalize.
- **Additive decay:** Subtracting a constant per hop doesn't scale with activation level and can go negative. Use multiplicative decay.
- **Returning all activated nodes:** Just like BFS returning everything reachable, returning all nodes above threshold defeats the purpose of scoring. Return top-K.
</architecture_patterns>

<dont_hand_roll>
## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Activation formula | Custom scoring heuristic | ACT-R base-level activation formula | 40+ years of cognitive science validation; custom heuristics won't capture access-pattern decay correctly |
| Noise distribution | Custom random perturbation | Box-Muller Gaussian transform | Well-understood statistical properties; log-space application prevents low-activation nodes from dominating |
| Convergence detection | Custom "has it settled" logic | Fixed iteration count (3 steps) | SYNAPSE, spreadr, and SA-RAG all use fixed steps; convergence detection adds complexity with no measurable benefit for small graphs |
| Graph cycle handling | Custom visited-set logic | Synchronous propagation + fixed steps | Synchronous propagation naturally handles cycles via dampening; no special cycle detection needed |
| Hub dominance prevention | Custom re-weighting | Fan-out normalization (divide by degree) | Standard approach from spreading activation literature; simple, effective, proven |

**Key insight:** The mathematical formulas from ACT-R and SYNAPSE are well-validated and directly implementable. The temptation is to simplify them or create custom alternatives, but these formulas exist because simpler approaches fail on edge cases (cycles, hubs, cold start, explosion).
</dont_hand_roll>

<common_pitfalls>
## Common Pitfalls

### Pitfall 1: Activation Explosion
**What goes wrong:** Without normalization, activation grows unboundedly when multiple paths converge on a single node. A node receiving input from 10 neighbors can exceed activation 1.0.
**Why it happens:** Additive accumulation without capping.
**How to avoid:** (1) Clamp activations to [0, 1.0] after each step. (2) Fan-out normalization — divide outgoing activation by source node's degree. (3) SYNAPSE uses both.
**Warning signs:** Activation values > 1.0; distant nodes scoring higher than direct neighbors.

### Pitfall 2: Hub Dominance (Rich-Get-Richer)
**What goes wrong:** Highly-connected nodes (memories with many relations) accumulate disproportionate activation, always appearing in results regardless of query relevance.
**Why it happens:** More incoming edges = more activation received, independent of semantic relevance.
**How to avoid:** Fan-out normalization divides by degree. SYNAPSE's lateral inhibition (beta=0.15, top-M=7) further suppresses weaker but over-connected nodes.
**Warning signs:** Same memories appearing in related results for every query; memories with high relation count always dominating.

### Pitfall 3: Deterministic Retrieval Staleness
**What goes wrong:** Without noise, the same query always returns the exact same related memories. Users perceive the system as "stuck" or unable to surface diverse context.
**Why it happens:** Spreading activation with fixed parameters is deterministic.
**How to avoid:** Gaussian noise (sigma=0.15-0.25) applied multiplicatively to final scores. ACT-R uses logistic noise for the same purpose.
**Warning signs:** Repeated queries returning byte-identical results; no serendipitous retrieval.

### Pitfall 4: Ignoring Existing Prominence
**What goes wrong:** Spreading activation scores don't account for memory staleness. An old, decayed memory (prominence=0.1) gets high activation because it has many edges.
**Why it happens:** Not composing activation with the existing decay/prominence system.
**How to avoid:** Multiply final activation by memory prominence: `finalScore = activation * prominence`. This integrates spatial (graph) and temporal (decay) relevance.
**Warning signs:** Very old memories appearing as top related results despite low prominence.

### Pitfall 5: Cold Start — New Memories Invisible
**What goes wrong:** New memories with no incoming edges never receive spreading activation.
**Why it happens:** Activation only flows through existing edges; new memories aren't connected yet.
**How to avoid:** The system already handles this — `detectRelations` runs at insertion time (scallop-store.ts:227), creating edges immediately. Additionally, new memories start with prominence=1.0, giving them a natural boost.
**Warning signs:** Recently added memories never appearing in related results.

### Pitfall 6: Performance Degradation with Large Graphs
**What goes wrong:** For each search result, spreading activation queries all relations for all active nodes at each step. With many memories, this becomes expensive.
**Why it happens:** Each step requires N relation queries where N = number of active nodes.
**How to avoid:** (1) Activation threshold (0.01) bounds the active set. (2) maxSteps=3 bounds iterations. (3) Consider batch-loading relations for the n-hop neighborhood via a single SQL CTE query.
**Warning signs:** Search latency increasing as memory count grows; many DB queries per search.
</common_pitfalls>

<code_examples>
## Code Examples

### ACT-R Base-Level Activation (Optimized Approximation)

```typescript
// Source: ACT-R Tutorial Unit 4, Petrov 2006 approximation
// Use this to compute a memory's "base strength" from its access history
function baseLevelActivation(
  accessCount: number,
  lifetimeMs: number,     // time since memory creation
  d: number = 0.5,        // decay parameter (ACT-R default)
): number {
  if (accessCount === 0 || lifetimeMs <= 0) return -Infinity;
  // Optimized form: B_i = ln(n / (1-d)) - d * ln(L)
  // L in seconds for reasonable scale
  const L = lifetimeMs / 1000;
  return Math.log(accessCount / (1 - d)) - d * Math.log(L);
}
```

### Synchronous Spreading Activation Core Loop

```typescript
// Source: spreadr package (PMC 2019), SYNAPSE (arXiv 2601.02744)
interface ActivationConfig {
  maxSteps: number;           // default: 3
  decayFactor: number;        // default: 0.5
  activationThreshold: number; // default: 0.01
  noiseSigma: number;          // default: 0.2
  resultThreshold: number;     // default: 0.05
  maxResults: number;          // default: 10
}

function propagate(
  seedId: string,
  getRelations: (id: string) => MemoryRelation[],
  config: ActivationConfig,
): Map<string, number> {
  let current = new Map<string, number>([[seedId, 1.0]]);

  for (let step = 0; step < config.maxSteps; step++) {
    const next = new Map<string, number>();

    for (const [id, activation] of current) {
      if (activation < config.activationThreshold) continue;

      // Retention: node keeps portion of its activation
      next.set(id, (next.get(id) ?? 0) + activation * (1 - config.decayFactor));

      // Spread to neighbors
      const relations = getRelations(id);
      const degree = relations.length || 1;

      for (const rel of relations) {
        const neighborId = rel.sourceId === id ? rel.targetId : rel.sourceId;
        const edgeWeight = getEdgeWeight(rel, id);
        const spread = activation * edgeWeight * config.decayFactor / degree;
        next.set(neighborId, Math.min(1.0, (next.get(neighborId) ?? 0) + spread));
      }
    }

    current = next;
  }

  current.delete(seedId);  // exclude the seed itself
  return current;
}
```

### Gaussian Noise (Box-Muller Transform)

```typescript
// Source: W3C CogAI specification
function gaussianNoise(sigma: number): number {
  if (sigma === 0) return 0;
  const u1 = Math.random();
  const u2 = Math.random();
  return sigma * Math.sqrt(-2 * Math.log(Math.max(1e-10, u1))) * Math.cos(2 * Math.PI * u2);
}

function applyNoise(activation: number, sigma: number): number {
  if (sigma === 0) return activation;
  return Math.max(0, activation * Math.exp(gaussianNoise(sigma)));
}
```

### SYNAPSE-Style Lateral Inhibition (Optional Enhancement)

```typescript
// Source: SYNAPSE (arXiv 2601.02744)
// Apply after propagation step, before sigmoid gating
function lateralInhibition(
  activations: Map<string, number>,
  beta: number = 0.15,  // inhibition strength
  topM: number = 7,     // number of top nodes for competition
): void {
  const sorted = [...activations.entries()].sort((a, b) => b[1] - a[1]);
  const topNodes = sorted.slice(0, topM);

  for (const [id, value] of activations) {
    let inhibition = 0;
    for (const [topId, topValue] of topNodes) {
      if (topId !== id && topValue > value) {
        inhibition += beta * (topValue - value);
      }
    }
    activations.set(id, Math.max(0, value - inhibition));
  }
}
```

### Integration Point in ScallopMemoryStore

```typescript
// Source: Current scallop-store.ts:452-454
// BEFORE:
for (const result of topResults) {
  result.relatedMemories = this.relationGraph.getRelatedMemoriesForContext(result.memory.id);
}

// AFTER:
for (const result of topResults) {
  result.relatedMemories = this.relationGraph.getRelatedMemoriesWithActivation(
    result.memory.id,
    activationConfig,
  );
}
```
</code_examples>

<sota_updates>
## State of the Art (2025-2026)

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| BFS/DFS graph traversal for related memories | Spreading activation with decay + noise | 2025-2026 (SYNAPSE, SA-RAG) | Produces ranked/scored results instead of unranked; 23% improvement on multi-hop retrieval |
| Cosine similarity only for retrieval | Triple hybrid: similarity + activation + structural | SYNAPSE Jan 2026 | Solves "contextual tunneling" where relevant memories share no semantic overlap |
| Static edge weights | Temporal decay on edge weights: w * exp(-ρ * Δt) | SYNAPSE 2026 | Recency-sensitive graph traversal |
| No lateral inhibition | Winner-take-all competition (beta=0.15, M=7) | SYNAPSE 2026 | Prevents hub dominance in large graphs |
| Deterministic retrieval | Stochastic noise (Gaussian/logistic) | ACT-R tradition, now adopted in AI agents | Retrieval diversity; prevents staleness |

**New tools/patterns to consider:**
- **SYNAPSE** (Jan 2026): Full spreading activation framework for AI agent episodic-semantic memory. Provides complete parameter set and algorithm. ArXiv 2601.02744.
- **SA-RAG** (Dec 2025): Simpler spreading activation for knowledge graph RAG. BFS-based propagation with edge weight rescaling. ArXiv 2512.15922. Up to 39% improvement.
- **A-MEM** (NeurIPS 2025): Zettelkasten-style agentic memory with LLM-maintained connections. Not spreading activation but complementary architecture. ArXiv 2502.12110.
- **ACT-R Memory for LLMs** (HAI 2025): Direct ACT-R integration with LLM generation, including temporal decay and probabilistic noise.

**Deprecated/outdated:**
- **Simple BFS for related memories:** Returns unranked results; no decay or scoring. Replaced by activation propagation.
- **Fixed-depth traversal without scoring:** Treats all memories at depth N as equally relevant. Spreading activation naturally ranks by relevance.
- **cannon-es style physics for activation:** Not applicable here but noted — the graph metaphor doesn't need physics simulation.
</sota_updates>

<open_questions>
## Open Questions

1. **Should lateral inhibition be included in v1?**
   - What we know: SYNAPSE uses lateral inhibition (beta=0.15, M=7) and reports improved results. SA-RAG does not use it and still achieves 39% improvement.
   - What's unclear: Whether our small graph (typically <1000 memories per user) benefits from inhibition, or if fan-out normalization is sufficient.
   - Recommendation: Start without lateral inhibition. Add it as a follow-up if hub dominance is observed in testing.

2. **Should we add a base-level activation component?**
   - What we know: ACT-R's BLA uses access history: `B_i = ln(Σ t_j^(-d))`. Our memories already have `accessCount` and `lastAccessed`. Our `prominence` field already captures temporal decay.
   - What's unclear: Whether composing `activation * prominence` (current plan) gives equivalent results to computing BLA from access history.
   - Recommendation: Start with `activation * prominence` composition since prominence already captures temporal decay. The ACT-R BLA formula can be added later if needed.

3. **Should spreading activation replace or augment the existing triple-hybrid score?**
   - What we know: SYNAPSE uses triple hybrid (similarity * 0.5 + activation * 0.3 + PageRank * 0.2). Our search already computes hybrid scores. The activation is currently only used for `relatedMemories` enrichment.
   - What's unclear: Whether activation scores should feed back into the main search ranking (replacing the reranker?) or remain a separate enrichment step.
   - Recommendation: Keep as enrichment step for Phase 20. Consider integrating into main search scoring in a future phase.

4. **Performance with n search results × m propagation steps**
   - What we know: Current search returns `limit` results (default 10). Each result triggers `getRelatedMemoriesForContext`. With 3 propagation steps and average degree ~3, that's ~10 * 3 * 3 = ~90 relation queries per search.
   - What's unclear: Whether this is acceptable latency for real-time conversations.
   - Recommendation: Batch-load relations for the n-hop neighborhood using a single SQL CTE query per seed, rather than individual queries per active node per step.
</open_questions>

<sources>
## Sources

### Primary (HIGH confidence)

- **ACT-R Tutorial Unit 4** — Base-level learning, activation decay formula, noise parameters. Verified against pyactr source code. http://act-r.psy.cmu.edu/wordpress/wp-content/themes/ACT-R/tutorials/unit4.htm
- **ACT-R Tutorial Unit 5** — Spreading activation formula, association strength, fan effect. http://act-r.psy.cmu.edu/wordpress/wp-content/themes/ACT-R/tutorials/unit5.htm
- **ACT-R 7.x Reference Manual** — Complete parameter reference with defaults. http://act-r.psy.cmu.edu/actr7.x/reference-manual.pdf
- **pyactr source code** — Python implementation of ACT-R activation formulas (utilities.py, declarative.py). https://github.com/jakdot/pyactr
- **SYNAPSE paper** — ArXiv 2601.02744 (Jan 2026). Complete spreading activation algorithm with all parameters for AI agent memory. https://arxiv.org/abs/2601.02744

### Secondary (MEDIUM confidence)

- **spreadr R package** — Published in Behavior Research Methods. Synchronous spreading activation simulation with retention parameter. https://pmc.ncbi.nlm.nih.gov/articles/PMC6478646/
- **SA-RAG** — ArXiv 2512.15922 (Dec 2025). Spreading activation for knowledge-graph RAG. Simpler algorithm, strong results. https://arxiv.org/abs/2512.15922
- **W3C CogAI specification** — Memory activation and decay with Gaussian noise model. https://github.com/w3c/cogai/issues/33
- **IEEE PPR vs Spreading Activation comparison** — Confirms mathematical equivalence under specific conditions. https://ieeexplore.ieee.org/document/9651836/
- **A-MEM** — ArXiv 2502.12110 (NeurIPS 2025). Agentic memory with dynamic linking. Not spreading activation but relevant architecture. https://arxiv.org/abs/2502.12110

### Tertiary (LOW confidence — needs validation during implementation)

- **Neo4j spreading activation gist** — Implementation demonstration, not peer-reviewed. Useful for code patterns only. https://gist.github.com/sanderd/910a03b871c16fd615ec6d4c018949cf
- **Petrov 2006 BLA approximation** — Optimized BLA formula. May need validation that approximation error is acceptable for our use case. http://alexpetrov.com/pub/iccm06/
</sources>

<metadata>
## Metadata

**Research scope:**
- Core technology: ACT-R activation formulas + SYNAPSE spreading activation algorithm
- Ecosystem: No external libraries — pure algorithmic change
- Patterns: Synchronous propagation, typed edge weights, fan-out normalization, stochastic noise
- Pitfalls: Activation explosion, hub dominance, deterministic staleness, cold start, performance

**Confidence breakdown:**
- Standard stack (formulas): HIGH — ACT-R formulas verified against multiple sources (tutorials, reference manual, pyactr source)
- Architecture (propagation algorithm): HIGH — SYNAPSE provides complete algorithm with parameters, cross-verified with spreadr and SA-RAG
- Pitfalls: HIGH — Well-documented in spreading activation literature (explosion, cycles, hubs)
- Code examples: MEDIUM — Pseudocode adapted from multiple sources; needs validation with actual DB queries and test data
- Parameter values: MEDIUM — SYNAPSE provides defaults tuned for their benchmark; may need tuning for our graph structure

**Research date:** 2026-02-10
**Valid until:** 2026-03-12 (30 days — field is actively evolving but core algorithms are stable)
</metadata>

---

*Phase: 20-spreading-activation*
*Research completed: 2026-02-10*
*Ready for planning: yes*
