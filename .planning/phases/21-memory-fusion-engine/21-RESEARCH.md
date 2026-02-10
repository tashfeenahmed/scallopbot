# Phase 21: Memory Fusion Engine - Research

**Researched:** 2026-02-10
**Domain:** Internal extension — memory cluster detection and LLM-guided content fusion in existing gardener/decay system
**Confidence:** HIGH

<research_summary>
## Summary

Investigated the existing codebase to determine what Phase 21 requires. The Memory Fusion Engine extends the `BackgroundGardener.deepTick()` to detect clusters of decaying related memories and merge them into single stronger summaries. This is inspired by FadeMem's claim of 82% retention at 55% storage.

The codebase already has all the building blocks:
- **Decay engine** (`decay.ts`) tracks prominence with biologically-inspired decay rates — dormant memories (prominence 0.1–0.5) are the natural fusion candidates
- **Relation graph** (`relations.ts`) with spreading activation can find memory clusters via graph connectivity
- **Consolidation** (`fact-extractor.ts:consolidateMemory()`) handles supersession but NOT content merging — this is the gap
- **Background gardener** (`memory.ts`) runs deep ticks every ~6 hours — natural place to add fusion
- **LLM classification** (`relation-classifier.ts`) has an unused `inferConnections()` method deferred from Phase 19 — potential integration point

No external libraries needed. This is purely about designing the right algorithm for cluster detection, LLM-guided content fusion, and wiring it into the existing deep tick.

**Primary recommendation:** Add a `fuseMemoryCluster()` function that (1) finds clusters of related dormant memories via the relation graph, (2) uses LLM to merge cluster content into a single consolidated summary, (3) stores the summary as a new `derived` memory with DERIVES relations, and (4) marks source memories as superseded. Wire into `deepTick()` after full decay scan.
</research_summary>

<standard_stack>
## Standard Stack

No new libraries needed. Everything is already in the codebase:

### Core (already exists)
| Component | Location | Purpose | Status |
|-----------|----------|---------|--------|
| BackgroundGardener | `src/memory/memory.ts` | Deep tick runs every ~6 hours | Extension point for fusion |
| DecayEngine | `src/memory/decay.ts` | Prominence-based decay with thresholds | Identifies dormant candidates |
| RelationGraph | `src/memory/relations.ts` | Memory graph with spreading activation | Finds clusters |
| RelationshipClassifier | `src/memory/relation-classifier.ts` | LLM-based classification + `inferConnections()` | Unused inference capability |
| ScallopMemoryStore | `src/memory/scallop-store.ts` | add/update/search with embeddings | Stores fused memories |

### Supporting (already exists)
| Component | Location | Purpose |
|-----------|----------|---------|
| ScallopDatabase | `src/memory/db.ts` | `getMemoriesByUser()`, `getAllMemories()`, `pruneArchivedMemories()` |
| CostTracker | `src/routing/cost.ts` | Wraps LLM providers for cost tracking |
| CachedEmbedder | `src/memory/embeddings.ts` | Generates embeddings for new fused memories |
| ProfileManager | `src/memory/profiles.ts` | Static/dynamic profile management |
</standard_stack>

<architecture_patterns>
## Architecture Patterns

### Fusion Pipeline (new, fits into deepTick)

```
deepTick() flow (current):
  1. Full decay scan
  2. Session summaries
  3. Pruning
  4. Behavioral inference

deepTick() flow (with fusion - NEW step 2):
  1. Full decay scan
  2. ★ Memory fusion (clusters of dormant/decaying memories)
  3. Session summaries
  4. Pruning
  5. Behavioral inference
```

Fusion runs AFTER full decay (so prominence values are current) and BEFORE pruning (so candidates haven't been deleted yet).

### Pattern 1: Cluster Detection via Relation Graph

**What:** Find connected components of dormant memories (prominence between DORMANT and ACTIVE thresholds) that share relations (UPDATES, EXTENDS, DERIVES)
**When to use:** During deep tick, after full decay scan updates prominence values

**Algorithm:**
1. Query all dormant memories (0.1 ≤ prominence < 0.5) for a user
2. For each, get its relations from the relation graph
3. Build connected components (union-find or BFS)
4. Filter clusters with ≥ 3 memories (singleton/pairs not worth fusing)
5. Sort clusters by total content length (fuse largest first to save most storage)
6. Cap at N clusters per deep tick to bound LLM cost

**Why 0.1–0.5 prominence range:**
- Below 0.1 (DORMANT threshold): Already archived, may contain noise
- Above 0.5 (ACTIVE threshold): Still actively relevant, don't disturb
- The 0.1–0.5 band contains memories that are fading but still have value — perfect fusion candidates

### Pattern 2: LLM-Guided Content Fusion

**What:** Use LLM to merge N related memories into a single coherent summary that preserves all important facts while eliminating redundancy
**When to use:** After cluster detection identifies fusion candidates

**Design:**
```
Input: [memory1.content, memory2.content, memory3.content, ...]
Output: { summary: string, importance: number, category: string }
```

**Key constraints:**
- Summary must be strictly shorter than combined source content (otherwise no storage benefit)
- Summary must preserve all non-redundant facts
- Category inherits from the most common category in the cluster
- Importance = max importance of source memories (preservation of value)
- Confidence = min confidence of sources (conservative)

### Pattern 3: Fused Memory Storage

**What:** Store the fused summary as a new `derived` memory with DERIVES relations to all source memories
**When to use:** After LLM fusion produces the summary

**Storage steps:**
1. Create new memory with `memoryType: 'derived'`, `learnedFrom: 'consolidation'`
2. Add DERIVES relations from fused → each source memory
3. Mark all source memories as `memoryType: 'superseded'` (fast decay rate 0.90)
4. Set `isLatest: false` on source memories
5. Fused memory starts with prominence = max(source prominences) + 0.1 boost (to keep it active)

### Anti-Patterns to Avoid
- **Fusing active memories:** Don't touch memories with prominence ≥ 0.5 — they're still being actively used
- **Fusing across users:** Always scope cluster detection to a single userId
- **Fusing across categories:** Don't merge `preference` with `event` — keep semantic coherence
- **Unbounded fusion:** Cap clusters per deep tick; LLM calls are expensive
- **Fusing static_profile memories:** These don't decay (rate = 1.0) and should never be fused
- **Recursive fusion:** Don't fuse `derived` memories that were themselves fusion results (at least in v1)
</architecture_patterns>

<dont_hand_roll>
## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cluster detection | Custom graph algorithm | RelationGraph + simple BFS on relations | The relation graph already has all edges; just traverse connected components |
| Content summarization | Template-based merging | LLM call (same pattern as consolidateMemory) | Semantic understanding needed to merge facts without losing meaning |
| Embedding generation | Custom embedding | CachedEmbedder via ScallopMemoryStore.add() | add() already handles embedding generation transparently |
| Relation creation | Manual DB inserts | RelationGraph.addRelation() | Handles deduplication and validation |
| Prominence calculation | Custom formula | DecayEngine.calculateProminence() | Already handles all type/category rate combinations |
| Finding dormant memories | Raw SQL | db.getMemoriesByUser() with prominence filter | Already exists with proper filtering |

**Key insight:** The existing codebase has solved all the infrastructure problems. Phase 21 is about composing existing primitives (relation graph traversal, LLM calls, memory storage) into a new pipeline step. The only genuinely new code is the cluster detection logic and the fusion LLM prompt.
</dont_hand_roll>

<common_pitfalls>
## Common Pitfalls

### Pitfall 1: Fusing Away Important Details
**What goes wrong:** LLM summary drops a fact that a source memory contained; information is permanently lost
**Why it happens:** LLM summaries naturally compress, and brief mentions in source memories can be omitted
**How to avoid:** Keep source memories in DB as `superseded` (don't delete them). They remain searchable at low priority via direct ID lookup. Also validate that fused content length > some minimum % of source content
**Warning signs:** User asks about something that was in a fused-away memory and agent can't find it

### Pitfall 2: Runaway LLM Costs During Deep Tick
**What goes wrong:** Hundreds of clusters → hundreds of LLM fusion calls per deep tick
**Why it happens:** No cap on clusters processed per tick; large memory stores have many dormant memories
**How to avoid:** Cap at 5-10 clusters per deep tick. Sort by cluster size descending (biggest storage savings first). Track fusion cost separately
**Warning signs:** Deep tick taking minutes instead of seconds; cost spikes every 6 hours

### Pitfall 3: Fusion Loop (Recursive Merging)
**What goes wrong:** A fused memory decays into dormant range and gets re-fused with new memories, losing the original consolidation
**Why it happens:** Fused memories are `derived` type (decay rate 0.98), so they decay over ~35 days
**How to avoid:** Skip `derived` memories as fusion candidates (at least in v1). OR mark fused memories with a `fusedAt` metadata field and impose a cooldown period
**Warning signs:** Memory count doesn't decrease over time despite fusion running

### Pitfall 4: Cross-Category Fusion Producing Incoherent Summaries
**What goes wrong:** Merging a `preference`, a `fact`, and an `event` into one summary produces an incoherent memory
**Why it happens:** Cluster detection finds connections across categories (e.g., "Lives in Dublin" + "Moved to Dublin in 2024" + "Prefers Dublin over London")
**How to avoid:** Only fuse within same category. Cross-category connections are still visible via relations but not merged
**Warning signs:** Fused memories have nonsensical content mixing temporal events with permanent facts

### Pitfall 5: Embedding Mismatch After Fusion
**What goes wrong:** Fused memory's embedding doesn't match queries that would have found the source memories
**Why it happens:** LLM summary uses different wording than sources; embedding captures the summary, not the originals
**How to avoid:** Include source content keywords in the fused memory's `sourceChunk` field for BM25 keyword matching. The embedding of the summary should be semantically broader than any single source
**Warning signs:** Search recall drops after fusion runs; users can't find things they know they told the agent
</common_pitfalls>

<code_examples>
## Code Examples

### Cluster Detection (BFS on relation graph)
```typescript
// Conceptual: find connected components of dormant memories
function findFusionClusters(
  dormantMemories: ScallopMemoryEntry[],
  db: ScallopDatabase,
  options: { minClusterSize: number; maxClusters: number }
): ScallopMemoryEntry[][] {
  const idSet = new Set(dormantMemories.map(m => m.id));
  const visited = new Set<string>();
  const clusters: ScallopMemoryEntry[][] = [];
  const memoryMap = new Map(dormantMemories.map(m => [m.id, m]));

  for (const memory of dormantMemories) {
    if (visited.has(memory.id)) continue;

    // BFS to find connected component
    const cluster: ScallopMemoryEntry[] = [];
    const queue = [memory.id];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);

      const mem = memoryMap.get(id);
      if (mem) cluster.push(mem);

      // Get relations for this memory
      const relations = db.getRelationsForMemory(id);
      for (const rel of relations) {
        const neighborId = rel.sourceId === id ? rel.targetId : rel.sourceId;
        if (idSet.has(neighborId) && !visited.has(neighborId)) {
          queue.push(neighborId);
        }
      }
    }

    if (cluster.length >= options.minClusterSize) {
      clusters.push(cluster);
    }
  }

  // Sort by cluster size (largest first) and cap
  return clusters
    .sort((a, b) => b.length - a.length)
    .slice(0, options.maxClusters);
}
```

### LLM Fusion Prompt (follows consolidateMemory pattern)
```typescript
// Conceptual: prompt for merging a cluster of memories
function buildFusionPrompt(memories: ScallopMemoryEntry[]): string {
  const memoryList = memories
    .map((m, i) => `${i + 1}. [${m.category}] "${m.content}" (importance: ${m.importance})`)
    .join('\n');

  return `You are a memory consolidation engine. Merge these related memories into a SINGLE concise summary that preserves ALL important facts.

MEMORIES TO MERGE:
${memoryList}

RULES:
1. The summary MUST be shorter than all memories combined
2. Preserve ALL distinct facts — do not drop any unique information
3. Use natural language, not a list
4. The summary should read as a single coherent memory entry
5. Set importance to the highest importance among source memories
6. Set category to the most common category

Respond with JSON only:
{"summary": "...", "importance": 1-10, "category": "preference|fact|event|relationship|insight"}`;
}
```

### Fused Memory Storage (follows existing add/update patterns)
```typescript
// Conceptual: store fused memory and mark sources as superseded
async function storeFusedMemory(
  store: ScallopMemoryStore,
  fusedContent: { summary: string; importance: number; category: MemoryCategory },
  sourceMemories: ScallopMemoryEntry[],
  userId: string
): Promise<string> {
  // 1. Store the fused summary
  const fusedId = await store.add({
    userId,
    content: fusedContent.summary,
    category: fusedContent.category,
    importance: fusedContent.importance,
    confidence: Math.min(...sourceMemories.map(m => m.confidence)),
    memoryType: 'derived',
    learnedFrom: 'consolidation',
    metadata: {
      fusedAt: new Date().toISOString(),
      sourceCount: sourceMemories.length,
      sourceIds: sourceMemories.map(m => m.id),
    },
    // Store source content keywords for BM25 matching
    sourceChunk: sourceMemories.map(m => m.content).join(' | '),
    detectRelations: false, // We'll add DERIVES relations manually
  });

  // 2. Add DERIVES relations
  const db = store.getDatabase();
  for (const source of sourceMemories) {
    db.addRelation({
      sourceId: fusedId,
      targetId: source.id,
      relationType: 'DERIVES',
      confidence: 0.95,
    });
  }

  // 3. Mark source memories as superseded
  for (const source of sourceMemories) {
    store.update(source.id, {
      isLatest: false,
      memoryType: 'superseded',
    });
  }

  return fusedId;
}
```

### Integration into BackgroundGardener.deepTick()
```typescript
// Conceptual: where fusion fits in deepTick
async deepTick(): Promise<void> {
  // 1. Full decay scan (existing)
  const fullDecayResult = this.scallopStore.processFullDecay();

  // 2. ★ Memory fusion (NEW)
  if (this.fusionEngine) {
    try {
      const fusionResult = await this.fusionEngine.fuseDecayingClusters({
        maxClusters: 5,
        minClusterSize: 3,
      });
      if (fusionResult.fused > 0) {
        this.logger.info(
          { fused: fusionResult.fused, memoriesMerged: fusionResult.memoriesMerged },
          'Memory fusion complete'
        );
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Memory fusion failed');
    }
  }

  // 3-5. Session summaries, pruning, behavioral inference (existing)
  // ...
}
```
</code_examples>

<sota_updates>
## State of the Art (2025-2026)

No external SOTA changes relevant — this is an internal extension using existing infrastructure.

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No memory consolidation content merging | LLM-guided cluster fusion | Phase 21 (new) | Reduces storage while preserving information |
| Supersession only (mark old as not-latest) | Supersession + content fusion | Phase 21 (new) | Better than just hiding old memories — synthesizes them |
| BFS-based related memories | Spreading activation (Phase 20) | 2026-02-10 | Better cluster detection via activation scores |

**FadeMem paper concepts applicable here:**
- **Biologically-inspired forgetting**: Already implemented via decay engine (Phase 18 area)
- **Memory fusion for storage reduction**: The core of Phase 21 — merge decaying clusters
- **82% retention at 55% storage**: Target metric — measure information retention vs storage savings
- **Cluster-based consolidation**: Use relation graph connectivity as cluster boundary

**What's NOT applicable from FadeMem:**
- FadeMem's neural network approach to fusion — we use LLM prompts instead (simpler, fits our architecture)
- FadeMem's continuous embedding space fusion — we do text-level merging (more interpretable)

**Already implemented (from prior phases):**
- `inferConnections()` exists in `relation-classifier.ts` but is unused — could be wired during fusion to discover implicit connections before merging
- Spreading activation (Phase 20) provides weighted graph traversal that could enhance cluster detection beyond simple BFS
</sota_updates>

<open_questions>
## Open Questions

1. **Should `inferConnections()` be wired during fusion?**
   - What we know: `RelationshipClassifier.inferConnections()` exists, unused, deferred from Phase 19
   - What's unclear: Whether to run inference on cluster members before fusing (enriches the fused summary) or keep it separate
   - Recommendation: Defer to a future enhancement. Keep Phase 21 focused on the core fusion loop. `inferConnections()` can be added later as a pre-fusion enrichment step

2. **What prominence should fused memories start at?**
   - What we know: Source memories are in the 0.1–0.5 (dormant) range. The fused memory should be "more alive" than its dying sources
   - What's unclear: Exact starting prominence — too high and it pollutes active context, too low and it decays before being useful
   - Recommendation: Use `max(source prominences) + 0.1` capped at 0.6. This puts the fused memory just above ACTIVE threshold, giving it a chance to prove its value through access before decaying naturally

3. **Should fusion respect category boundaries strictly?**
   - What we know: Cross-category fusion (e.g., `fact` + `event`) can produce incoherent summaries
   - What's unclear: Whether clusters naturally respect categories via relations, or if explicit filtering is needed
   - Recommendation: Filter clusters to same-category members. If a cluster spans categories, only fuse the largest same-category subset

4. **How to measure "82% retention at 55% storage"?**
   - What we know: FadeMem claims this metric. We need to validate our fusion achieves similar
   - What's unclear: How to measure "retention" in our system (semantic similarity of fused vs source? Search recall before/after?)
   - Recommendation: Track via integration tests: insert N memories → fuse → verify that search queries that found source memories still find the fused memory. Report recall rate and storage reduction %
</open_questions>

<sources>
## Sources

### Primary (HIGH confidence)
- `src/memory/memory.ts` — BackgroundGardener with lightTick/deepTick
- `src/memory/decay.ts` — DecayEngine with prominence thresholds (ACTIVE=0.5, DORMANT=0.1, ARCHIVED=0.0)
- `src/memory/relations.ts` — RelationGraph with spreading activation and edge weights
- `src/memory/relation-classifier.ts` — RelationshipClassifier with unused `inferConnections()`
- `src/memory/fact-extractor.ts:consolidateMemory()` — Existing supersession-only consolidation pattern
- `src/memory/scallop-store.ts` — add/update/search pipeline with embedding generation
- `src/memory/db.ts` — Schema, `getMemoriesByUser()`, `pruneArchivedMemories()`, `getRelationsForMemory()`

### Secondary (MEDIUM confidence)
- FadeMem paper (Jan 2026) — Referenced in ROADMAP.md with "82% retention at 55% storage" claim. Exact algorithm details not verified via web search (search unavailable). Concepts adapted to fit existing architecture
- Phase 19 RESEARCH.md — Documents `inferConnections()` deferral to Phase 21
- Phase 20 SUMMARY.md — Confirms spreading activation is integrated and ready

### Tertiary (LOW confidence - needs validation)
- FadeMem storage reduction metrics (82%/55%) — Cited in roadmap but not independently verified. Use as aspirational target, measure actual results
</sources>

<metadata>
## Metadata

**Research scope:**
- Core technology: Internal TypeScript — BackgroundGardener extension
- Ecosystem: N/A (no external libraries)
- Patterns: Cluster detection via relation graph BFS, LLM-guided content fusion, derived memory storage
- Pitfalls: Information loss, LLM cost, recursive fusion, cross-category incoherence, embedding mismatch

**Confidence breakdown:**
- Standard stack: HIGH — all components already exist in codebase
- Architecture: HIGH — follows established patterns (gardener deep tick, LLM consolidation, relation graph)
- Pitfalls: HIGH — derived from direct code analysis and understanding of decay/search systems
- Code examples: HIGH — based on actual codebase patterns and interfaces

**Research date:** 2026-02-10
**Valid until:** N/A (internal codebase, no external dependencies to go stale)
</metadata>

---

*Phase: 21-memory-fusion-engine*
*Research completed: 2026-02-10*
*Ready for planning: yes*
