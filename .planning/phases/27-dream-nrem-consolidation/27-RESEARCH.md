# Phase 27: Dream NREM Consolidation - Research

**Researched:** 2026-02-10
**Domain:** Internal extension — expand fusion.ts for cross-category NREM consolidation, wire into Tier 3 sleep tick
**Confidence:** HIGH

<research_summary>
## Summary

Researched the existing codebase (fusion.ts, memory.ts gardener, Tier 3 sleep infrastructure) and cross-referenced with the bio-inspired research report and external SOTA (SimpleMem, LightMem, A-Mem, LangMem) to determine how to implement NREM consolidation.

Phase 27 extends the existing `findFusionClusters()` / `fuseMemoryCluster()` pipeline with three changes: (1) widen prominence window from `[0.1, 0.5)` to `[0.05, 0.8)`, (2) remove the same-category split so clusters can span categories, and (3) enrich the fusion prompt with relation context between cluster members. The new NREM function orchestrates these enhanced operations and is called from the existing `sleepTick()` placeholder in `BackgroundGardener`.

External research validates this approach: SimpleMem (Jan 2026) uses an affinity-threshold clustering model with offline consolidation during idle periods, achieving 26.4% F1 improvement over Mem0. LightMem decouples consolidation from online inference via sleep-time updates. A-Mem (NeurIPS 2025) demonstrates that cross-topic memory linking with LLM-generated contextual descriptions produces more coherent clustering. All three confirm that offline batch consolidation is the standard pattern.

**Primary recommendation:** Create a `nrem-consolidation.ts` module with a pure `nremConsolidate()` function that reuses `findFusionClusters()` (with overridden config for wider window + cross-category) and an enhanced `fuseMemoryClusterWithContext()` that enriches the LLM prompt with relation metadata. Wire into `sleepTick()`. No new libraries needed.
</research_summary>

<standard_stack>
## Standard Stack

No new libraries needed. Everything is already in the codebase:

### Core (already exists, will be extended)
| Component | Location | Purpose | Phase 27 Change |
|-----------|----------|---------|-----------------|
| `findFusionClusters()` | `src/memory/fusion.ts` | BFS cluster detection with category split | Override config: wider prominence window, skip category split |
| `fuseMemoryCluster()` | `src/memory/fusion.ts` | LLM-guided content fusion | Enhance prompt with relation context |
| `BackgroundGardener.sleepTick()` | `src/memory/memory.ts:436-443` | Tier 3 sleep tick (currently placeholder) | Wire NREM consolidation as first sleep operation |
| `getRelationsForMemory()` | `src/memory/db.ts` | Fetch relations for a memory ID | Used to build relation context for enriched prompt |

### Supporting (already exists, no changes)
| Component | Location | Purpose |
|-----------|----------|---------|
| `ScallopMemoryStore` | `src/memory/scallop-store.ts` | add/update/search for storing fused memories |
| `DecayEngine` | `src/memory/decay.ts` | Prominence thresholds and decay rates |
| `RelationGraph` | `src/memory/relations.ts` | Spreading activation, edge weights |
| `CachedEmbedder` | `src/memory/embeddings.ts` | Embedding generation for fused memories |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Extending `findFusionClusters()` via config | New function from scratch | Config override is cleaner — reuses existing tested BFS logic |
| Relation context in prompt | SimpleMem-style affinity scores | Our relation graph already captures semantic connections; affinity computation would duplicate work |
| A-Mem-style memory evolution | LLM fusion (current approach) | A-Mem updates existing memories in-place; our DERIVES+supersede pattern is more auditable and reversible |
</standard_stack>

<architecture_patterns>
## Architecture Patterns

### Where NREM Fits in the Architecture

```
BackgroundGardener tick hierarchy:

Tier 1 (Light) — every 5 min
├── Incremental decay
├── Expire scheduled items
├── Health ping
├── Deep tick trigger (every 72 light ticks)
└── Sleep tick trigger (every 288 light ticks + quiet hours)

Tier 2 (Deep) — every 6 hours
├── Full decay scan
├── Memory fusion (same-category, [0.1, 0.5) — EXISTING)
├── Session summaries
├── Pruning
├── Behavioral inference
├── Retrieval audit
├── Trust score
└── Goal deadline check

Tier 3 (Sleep) — nightly during quiet hours
├── ★ NREM Consolidation (Phase 27 — THIS PHASE)
├── REM Exploration (Phase 28 — future)
└── Self-Reflection (Phase 30 — future)
```

### Pattern 1: NREM as Enhanced Fusion (Config Override + Prompt Enrichment)

**What:** NREM reuses `findFusionClusters()` with overridden config, then calls an enhanced fusion function with relation context
**When to use:** During `sleepTick()`, nightly
**Why this pattern:** The existing fusion pipeline is already tested and working. NREM is not a different algorithm — it's the same algorithm with relaxed constraints and richer context, enabled by the offline budget of sleep time.

**Approach:**
```typescript
// nrem-consolidation.ts — pure function, no DB injection
export async function nremConsolidate(
  memories: ScallopMemoryEntry[],
  getRelations: (memoryId: string) => MemoryRelation[],
  provider: LLMProvider,
  options?: Partial<NremConfig>,
): Promise<NremResult>
```

Key config differences from daytime deep-tick fusion:
| Parameter | Deep Tick (existing) | NREM Sleep |
|-----------|---------------------|------------|
| `minProminence` | 0.1 (DORMANT) | 0.05 (below DORMANT — catches memories entering dormancy) |
| `maxProminence` | 0.5 (ACTIVE) | 0.8 (includes fresh-but-clustered memories) |
| `crossCategory` | false (split by category) | true (allow cross-category clusters) |
| `maxClusters` | 5 | 10 (higher budget during offline) |
| `enrichRelationContext` | false | true (include relation metadata in prompt) |

### Pattern 2: Relation Context Enrichment in Fusion Prompt

**What:** When fusing a cross-category cluster, include the relation types and target labels between cluster members so the LLM understands *why* these memories are connected
**When to use:** NREM fusion (not deep tick fusion, which stays same-category and simple)

**Enrichment approach:**
1. For each memory in the cluster, fetch its relations to other cluster members
2. Build a "relation map" showing intra-cluster connections
3. Include this map in the fusion prompt so the LLM can synthesize the conceptual thread

**Example enriched prompt section:**
```
MEMORIES TO MERGE:
1. [fact] "User is interested in learning Rust" (importance: 7)
   → EXTENDS memory#3 (programming interests)
2. [event] "User expressed frustration with Node.js memory leaks" (importance: 6)
   → DERIVES from session discussion about deployment issues
3. [preference] "User prefers type-safe languages" (importance: 8)
   → EXTENDS memory#1

CONNECTIONS:
- Memory 1 ↔ Memory 3: Both relate to programming language preferences
- Memory 2 → Memory 1: Frustration with Node.js may drive interest in Rust
```

This enables the LLM to produce a synthesis like: "User is moving toward Rust due to frustration with Node.js memory leaks, reflecting a strong preference for type-safe languages."

### Pattern 3: Cross-Category Cluster Coherence Guard

**What:** When cross-category is enabled, validate that clusters have semantic coherence via the relation graph (not just random category mixing)
**When to use:** After BFS finds connected components, before fusion

**Guard logic:**
- A cross-category cluster is only valid if every memory in it has at least one relation to another cluster member (i.e., no orphan stragglers that happen to be in the prominence window but aren't actually connected)
- This is naturally enforced by the BFS algorithm — memories only join a cluster if they have a relation path to at least one other member
- Additional guard: if a cluster has >2 distinct categories and >5 members, consider splitting into sub-clusters of ≤5 to keep LLM prompt focused

### Anti-Patterns to Avoid
- **Running NREM during online hours:** The wider prominence window and higher cluster cap could interfere with active retrieval if run during user interactions. NREM is explicitly gated to quiet hours.
- **Fusing `derived` memories in NREM:** Same as deep tick — skip `derived` type to prevent recursive fusion. The `findFusionClusters()` filter already excludes them.
- **Fusing `static_profile` in NREM:** Same exclusion — these don't decay and shouldn't be consolidated.
- **Unbounded relation context:** If a memory has 20+ relations, don't include all of them in the prompt. Cap at relations to other cluster members only (intra-cluster relations).
- **Replacing deep-tick fusion:** NREM supplements deep-tick fusion, not replaces it. Deep tick continues to handle same-category dormant fusion during the day. NREM handles the deeper cross-category synthesis at night.
</architecture_patterns>

<dont_hand_roll>
## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| BFS cluster detection | New graph traversal | `findFusionClusters()` with config override | Already tested, handles edge cases (visited tracking, orphans) |
| Prominence filtering | Custom SQL query | Existing prominence filter in `findFusionClusters()` | minProminence/maxProminence are already configurable |
| LLM fusion call | New prompt pattern | Extend `fuseMemoryCluster()` or create thin wrapper | JSON parsing, validation, error handling already done |
| Memory storage after fusion | Manual DB operations | Existing deep-tick fusion storage pattern in `memory.ts:176-261` | DERIVES relations, supersession marking, prominence boost |
| Sleep tick scheduling | Custom timer | `BackgroundGardener.sleepTick()` placeholder | Tier 3 infrastructure (tick counter + quiet hours gate) already built |
| Embedding for fused memory | Custom embedding code | `ScallopMemoryStore.add()` | Handles embedding generation transparently |

**Key insight:** Phase 27's actual net-new code is small: (1) a `nremConsolidate()` orchestrator function, (2) an enhanced fusion prompt builder that adds relation context, and (3) a config constant for NREM parameters. Everything else is reuse.
</dont_hand_roll>

<common_pitfalls>
## Common Pitfalls

### Pitfall 1: Cross-Category Fusion Producing Incoherent Summaries
**What goes wrong:** Merging a `preference`, `fact`, and `event` into one summary produces nonsensical text like "User prefers Rust and had a meeting last Tuesday about compiler bugs"
**Why it happens:** Without relation context, the LLM doesn't understand why these categories are connected
**How to avoid:** The relation context enrichment is not optional — it's what makes cross-category fusion coherent. The prompt must explain the semantic thread connecting the memories. Additionally, keep cluster sizes manageable (≤8 memories) so the LLM can reason about all connections
**Warning signs:** Fused memories with mixed temporal and non-temporal content; summaries that read like disconnected lists rather than coherent insights

### Pitfall 2: NREM Cannibalizing Active Memories
**What goes wrong:** The wider prominence window [0.05, 0.8) captures memories that are still actively being used in conversation context, and marking them `superseded` degrades recent context quality
**Why it happens:** Upper bound of 0.8 includes some fresh memories
**How to avoid:** NREM only runs during quiet hours (2-5 AM default), when the user isn't interacting. Also, the fused memory inherits max prominence + boost, so retrieval quality shouldn't degrade. Critical: only supersede source memories AFTER the fused memory is stored and verified
**Warning signs:** User complains about agent forgetting recent things discussed yesterday

### Pitfall 3: Relation Context Overwhelming the Prompt
**What goes wrong:** A cluster of 8 memories with 20+ inter-relations produces a prompt that's too long for the LLM context, or the relation noise drowns out the actual content
**Why it happens:** Dense relation graphs can produce verbose context sections
**How to avoid:** Only include intra-cluster relations (not external relations). Cap relation context to 3 most relevant relations per memory (sorted by confidence). Use concise format: `"→ EXTENDS: [brief content of target]"` not full memory text
**Warning signs:** Fusion LLM responses become unfocused or exceed token limits

### Pitfall 4: Duplicate Consolidation (Deep Tick + NREM)
**What goes wrong:** A cluster of dormant same-category memories gets fused during deep tick, then the fused result enters NREM's wider window and gets re-processed
**Why it happens:** Overlap between deep tick's [0.1, 0.5) window and NREM's [0.05, 0.8) window
**How to avoid:** The existing `memoryType !== 'derived'` filter in `findFusionClusters()` already prevents this — fused memories are `derived` type and excluded from future fusion. No additional guard needed
**Warning signs:** N/A — already handled by existing filter

### Pitfall 5: Sleep Tick Timeout or Failure Blocking Future Sleep Ticks
**What goes wrong:** NREM consolidation takes too long (many clusters, slow LLM calls), and the sleep tick never completes, or an error prevents future sleep ticks
**Why it happens:** No timeout on the overall NREM operation; error in one cluster kills the whole batch
**How to avoid:** Process clusters sequentially with per-cluster error isolation (try/catch per cluster, continue on failure). Set an overall timeout (e.g., 5 minutes) for the entire NREM phase. Log metrics (clusters processed, time elapsed) for monitoring. The sleep tick counter resets to 0 when `sleepTick()` fires, so even if it fails, the next sleep tick fires 24 hours later
**Warning signs:** Sleep tick logs show timeouts or consistently partial completions
</common_pitfalls>

<code_examples>
## Code Examples

Verified patterns from existing codebase:

### NREM Consolidation Orchestrator (new module)
```typescript
// Source: follows fusion.ts pure function pattern
import { findFusionClusters, fuseMemoryCluster } from './fusion.js';
import type { ScallopMemoryEntry, MemoryRelation } from './db.js';
import type { LLMProvider } from '../providers/types.js';

export interface NremConfig {
  minProminence: number;  // 0.05
  maxProminence: number;  // 0.8
  maxClusters: number;    // 10
  minClusterSize: number; // 3
  maxRelationsPerMemory: number; // 3
}

export const DEFAULT_NREM_CONFIG: NremConfig = {
  minProminence: 0.05,
  maxProminence: 0.8,
  maxClusters: 10,
  minClusterSize: 3,
  maxRelationsPerMemory: 3,
};

export interface NremResult {
  clustersProcessed: number;
  memoriesConsolidated: number;
  failures: number;
}

export async function nremConsolidate(
  memories: ScallopMemoryEntry[],
  getRelations: (memoryId: string) => MemoryRelation[],
  provider: LLMProvider,
  options?: Partial<NremConfig>,
): Promise<NremResult> {
  const config = { ...DEFAULT_NREM_CONFIG, ...options };

  // Step 1: Find cross-category clusters using wider window
  // Note: pass crossCategory option to skip the category split
  const clusters = findFusionClusters(memories, getRelations, {
    minProminence: config.minProminence,
    maxProminence: config.maxProminence,
    maxClusters: config.maxClusters,
    minClusterSize: config.minClusterSize,
  });

  // Step 2: Fuse each cluster with relation context
  let consolidated = 0;
  let failures = 0;

  for (const cluster of clusters) {
    try {
      const relationContext = buildRelationContext(cluster, getRelations, config.maxRelationsPerMemory);
      const result = await fuseMemoryClusterWithContext(cluster, relationContext, provider);
      if (result) {
        consolidated += cluster.length;
      } else {
        failures++;
      }
    } catch {
      failures++;
    }
  }

  return {
    clustersProcessed: clusters.length,
    memoriesConsolidated: consolidated,
    failures,
  };
}
```

### Relation Context Builder
```typescript
// Source: follows pure function pattern from fusion.ts/relations.ts
interface RelationContextEntry {
  memoryIndex: number;
  relationType: string;
  targetIndex: number;
  targetContent: string; // brief excerpt
  confidence: number;
}

function buildRelationContext(
  cluster: ScallopMemoryEntry[],
  getRelations: (memoryId: string) => MemoryRelation[],
  maxPerMemory: number,
): RelationContextEntry[] {
  const idToIndex = new Map(cluster.map((m, i) => [m.id, i]));
  const entries: RelationContextEntry[] = [];

  for (let i = 0; i < cluster.length; i++) {
    const memory = cluster[i];
    const relations = getRelations(memory.id);
    let count = 0;

    for (const rel of relations) {
      if (count >= maxPerMemory) break;

      const neighborId = rel.sourceId === memory.id ? rel.targetId : rel.sourceId;
      const neighborIndex = idToIndex.get(neighborId);

      if (neighborIndex !== undefined) {
        entries.push({
          memoryIndex: i + 1,
          relationType: rel.relationType,
          targetIndex: neighborIndex + 1,
          targetContent: cluster[neighborIndex].content.slice(0, 80),
          confidence: rel.confidence,
        });
        count++;
      }
    }
  }

  return entries;
}
```

### Enhanced Fusion Prompt (with relation context)
```typescript
// Source: extends existing buildFusionPrompt from fusion.ts
function buildNremFusionPrompt(
  cluster: ScallopMemoryEntry[],
  relationContext: RelationContextEntry[],
): CompletionRequest {
  const system = `You are a memory consolidation engine performing deep sleep consolidation. Merge these related memories into a SINGLE coherent summary that captures the conceptual thread connecting them.

Rules:
1. The summary MUST be shorter than all memories combined
2. Preserve ALL distinct facts — do not drop any unique information
3. Synthesize cross-category connections into coherent insights
4. Use the CONNECTIONS section to understand WHY these memories are related
5. The summary should capture the deeper pattern, not just list facts

Respond with JSON only:
{"summary": "...", "importance": 1-10, "category": "preference|fact|event|relationship|insight"}`;

  const memoryLines = cluster
    .map((m, i) => `${i + 1}. [${m.category}] "${m.content}" (importance: ${m.importance})`)
    .join('\n');

  const connectionLines = relationContext.length > 0
    ? relationContext
        .map(r => `- Memory ${r.memoryIndex} ${r.relationType} → Memory ${r.targetIndex}`)
        .join('\n')
    : 'No explicit connections — these memories co-occur in the same semantic space.';

  const userMessage = `MEMORIES TO MERGE:
${memoryLines}

CONNECTIONS:
${connectionLines}

Synthesize into a single coherent memory (JSON only):`;

  return {
    messages: [{ role: 'user', content: userMessage }],
    system,
    temperature: 0.1,
    maxTokens: 500,
  };
}
```

### Wiring into sleepTick()
```typescript
// Source: extends memory.ts:436-443 sleepTick() placeholder
async sleepTick(): Promise<void> {
  this.logger.info('Sleep tick: nightly cognitive processing starting');

  // Phase 27: NREM Consolidation
  if (this.fusionProvider) {
    try {
      const userIds = this.db.getDistinctUserIds();
      for (const userId of userIds) {
        const memories = this.db.getMemoriesByUser(userId);
        const result = await nremConsolidate(
          memories,
          (id) => this.db.getRelationsForMemory(id),
          this.fusionProvider,
        );
        if (result.clustersProcessed > 0) {
          this.logger.info({ userId, ...result }, 'NREM consolidation complete');
        }
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'NREM consolidation failed');
    }
  }

  // Phase 28: REM Exploration (future)
  // Phase 30: Self-Reflection (future)

  this.logger.info('Sleep tick complete');
}
```
</code_examples>

<sota_updates>
## State of the Art (2025-2026)

External research validates our approach and offers refinements:

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Same-category fusion only | Cross-category with relation context (A-Mem, SimpleMem) | 2025-2026 | Industry consensus: cross-category links produce deeper insights |
| Online consolidation | Offline/sleep-time consolidation (LightMem, SimpleMem) | 2025-2026 | Decoupling consolidation from inference is standard pattern |
| Content-only fusion prompt | Relation-enriched context (A-Mem, LangMem) | 2025 | LLM produces better synthesis when it understands connections |
| Fixed prominence window | Wider window during offline (SimpleMem affinity threshold) | Jan 2026 | More aggressive processing is safe when user isn't interacting |

**New patterns from external research:**

- **SimpleMem affinity scores** (Jan 2026): `ωᵢⱼ = β·cos(vᵢ,vⱼ) + (1−β)·e^(−λ|tᵢ−tⱼ|)` — semantic similarity + temporal proximity. Our relation graph already captures semantic connections, so we don't need the cosine similarity computation. The temporal proximity signal could be useful as a tiebreaker but isn't critical for v1
- **A-Mem memory evolution** (NeurIPS 2025): Instead of merging, A-Mem updates existing memories' contextual descriptions in-place. Our DERIVES+supersede pattern is more auditable — we keep the originals
- **LightMem sleep-time updates** (Oct 2025): Three-stage pipeline (sensory → short-term → long-term with sleep update). Validates our approach of decoupled offline processing
- **LangMem subconscious formation** (2025): Background pattern analysis without impacting response time. Aligns with our Tier 3 async processing model
- **"Language Models Need Sleep" (OpenReview Oct 2025):** Proposes "Knowledge Seeding" — distilling smaller model memories into larger network during sleep. Not directly applicable (we use a single LLM), but validates the sleep-phase consolidation concept
- **MemAgents ICLR 2026 Workshop:** Emerging research frontier in memory automation, multi-agent memory, and trustworthiness. Indicates the field is converging on structured offline consolidation

**Not applicable:**
- SimpleMem's embedding-based affinity clustering — our relation graph already provides the semantic connection signal
- A-Mem's Zettelkasten-style note structure — our memory schema is sufficient
- LightMem's token compression — not relevant to our application-level memory store
</sota_updates>

<open_questions>
## Open Questions

1. **Should `findFusionClusters()` gain a `crossCategory` flag or should NREM use its own cluster function?**
   - What we know: The current `findFusionClusters()` splits components by category at lines 131-147. NREM needs to skip this split
   - What's unclear: Whether to add a boolean flag to `FusionConfig` or create a separate function
   - Recommendation: Add `crossCategory?: boolean` to `FusionConfig` (default false). When true, skip the category split step. This keeps one tested function and makes the config difference explicit

2. **Should NREM fused memories use a different `learnedFrom` value than deep-tick fusion?**
   - What we know: Both use `learnedFrom: 'consolidation'` currently. NREM produces conceptually different fusions (cross-category synthesis vs same-category compression)
   - What's unclear: Whether downstream code cares about distinguishing them
   - Recommendation: Use `learnedFrom: 'nrem_consolidation'` to distinguish from daytime `consolidation`. This enables future analytics on dream vs daytime fusion quality

3. **What is the optimal `maxProminence` for NREM — 0.7 or 0.8?**
   - What we know: The bio-inspired report says 0.8. But memories at 0.7-0.8 prominence are quite fresh (recently accessed or high importance)
   - What's unclear: Whether including very fresh memories causes quality issues
   - Recommendation: Start with 0.8 per the report design, but add a `fusedAt` cooldown — don't fuse memories created within the last 24 hours (they haven't had time to decay meaningfully). This protects recent memories while honoring the wider window

4. **How should the fused memory's category be determined for cross-category clusters?**
   - What we know: Same-category fusion uses most-common-category. Cross-category clusters may have no dominant category
   - What's unclear: Whether the fused memory should always be `insight` (since it's a synthesis) or follow the most-common pattern
   - Recommendation: For cross-category clusters specifically, default to `insight` category since the synthesis represents a derived understanding across categories. For same-category clusters (within NREM), keep the most-common-category logic
</open_questions>

<sources>
## Sources

### Primary (HIGH confidence)
- `src/memory/fusion.ts` — `findFusionClusters()` with BFS + category split, `fuseMemoryCluster()` with LLM prompt, `FusionConfig` with prominence window
- `src/memory/memory.ts:436-443` — `sleepTick()` placeholder awaiting Phase 27
- `src/memory/memory.ts:150-156` — Tier 3 sleep tick scheduling with quiet hours gate
- `src/memory/decay.ts` — `PROMINENCE_THRESHOLDS` (ACTIVE=0.5, DORMANT=0.1, ARCHIVED=0.0)
- `src/memory/db.ts` — Schema, `getRelationsForMemory()`, memory types
- `.planning/phases/21-memory-fusion-engine/21-RESEARCH.md` — Phase 21 fusion research (foundation for Phase 27)
- Bio-inspired research report (`pdf/smartbot-bioinspired-ai-report.typ`) — NREM design spec: `[0.05, 0.8)` window, cross-category, relation context enrichment

### Secondary (MEDIUM confidence)
- [SimpleMem (Jan 2026)](https://arxiv.org/abs/2601.02553) — Recursive memory consolidation with affinity scores, offline sleep processing. Validates approach, affinity formula cross-referenced
- [A-Mem (NeurIPS 2025)](https://arxiv.org/abs/2502.12110) — Memory evolution + linking across categories. Validates cross-category approach with LLM-generated contextual descriptions
- [LightMem (Oct 2025)](https://arxiv.org/abs/2510.18866) — Sleep-time update mechanism decoupling consolidation from inference. Validates offline processing pattern
- [LangMem conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) — Subconscious formation pattern, memory reconciliation. Validates background processing approach
- [Amazon Bedrock AgentCore memory prompts](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-system-prompt.html) — Conservative memory manager operations (Add/Update/Skip). Informs prompt design for consolidation
- ["Language Models Need Sleep" (OpenReview Oct 2025)](https://openreview.net/forum?id=iiZy6xyVVE) — Sleep paradigm for continual learning. Validates sleep-phase concept

### Tertiary (LOW confidence - needs validation)
- Cross-category fusion quality — no production evidence of cross-category LLM fusion in personal memory agents. A-Mem links across categories but doesn't fuse them. Our approach (fuse with relation context) is novel and needs empirical validation during implementation
</sources>

<metadata>
## Metadata

**Research scope:**
- Core technology: Internal TypeScript — extending fusion.ts + memory.ts
- Ecosystem: No external libraries (confirmed by all research paths)
- Patterns: Cross-category BFS clustering, relation-enriched LLM fusion, offline sleep consolidation
- Pitfalls: Incoherent cross-category summaries, active memory cannibalization, prompt bloat, duplicate consolidation

**Confidence breakdown:**
- Standard stack: HIGH — all components exist, only config/prompt changes needed
- Architecture: HIGH — follows established pure function pattern, sleep tick infrastructure ready
- Pitfalls: HIGH — derived from code analysis + external research patterns + Phase 21 experience
- Code examples: HIGH — based on actual fusion.ts patterns and interfaces
- Cross-category fusion quality: MEDIUM — approach is sound but novel in this domain; needs empirical validation

**Research date:** 2026-02-10
**Valid until:** N/A (internal codebase + stable external research, no dependencies to go stale)
</metadata>

---

*Phase: 27-dream-nrem-consolidation*
*Research completed: 2026-02-10*
*Ready for planning: yes*
