# Phase 19: LLM-Guided Memory Relations - Research

**Researched:** 2026-02-10
**Domain:** Internal refactoring — replace regex heuristics with existing LLM classifier
**Confidence:** HIGH

<research_summary>
## Summary

Investigated the codebase to determine what Phase 19 requires. The LLM-based `RelationshipClassifier` already exists in `relation-classifier.ts` and is already integrated into `fact-extractor.ts` for batch classification. The remaining work is replacing the regex-based `detectContradiction()` and `detectEnrichment()` methods in `relations.ts` with calls to the existing `RelationshipClassifier`.

This is purely an internal wiring task — no external libraries, no ecosystem research, no new patterns needed. The LLM prompt, JSON parsing, error handling, and batch classification are all established patterns in the codebase (fact-extractor, reranker, relation-classifier).

**Primary recommendation:** Wire the existing `RelationshipClassifier` into `RelationGraph.classifyRelation()` to replace the 7-pattern regex heuristic. Follow the same constructor injection pattern used by reranker (optional LLM provider, graceful fallback to regex on failure).
</research_summary>

<standard_stack>
## Standard Stack

No new libraries needed. Everything is already in the codebase:

### Core (already exists)
| Component | Location | Purpose | Status |
|-----------|----------|---------|--------|
| RelationshipClassifier | `src/memory/relation-classifier.ts` | LLM-based relation classification (NEW/UPDATES/EXTENDS) | Built, tested, integrated in fact-extractor |
| RelationGraph | `src/memory/relations.ts` | Memory graph management + relation detection | Built, but uses regex for classification |
| LLMProvider | `src/providers/types.ts` | Abstract LLM interface used by all LLM features | Established pattern |

### Supporting (already exists)
| Component | Location | Purpose |
|-----------|----------|---------|
| CostTracker | `src/routing/cost.ts` | Wraps LLM providers for cost tracking |
| ScallopMemoryStore | `src/memory/scallop-store.ts` | Owns RelationGraph, calls detectRelations |
</standard_stack>

<architecture_patterns>
## Architecture Patterns

### Established Pattern: Optional LLM Provider with Graceful Fallback

All LLM-enhanced features in this codebase follow the same pattern:

1. **Constructor injection**: LLM provider passed optionally
2. **Graceful fallback**: If LLM fails or isn't provided, fall back to non-LLM behavior
3. **Cost tracking**: Wrap provider with CostTracker when available

Examples already in codebase:
- `reranker.ts`: Stateless function, takes `LLMProvider` as argument, falls back to original scores
- `fact-extractor.ts`: `useRelationshipClassifier` flag, creates classifier in constructor, falls back to NEW on error
- `relation-classifier.ts`: Returns `{ classification: 'NEW', confidence: 0.5 }` on any error

### Pattern to Follow for Phase 19

```
RelationGraph constructor:
  - Accept optional LLMProvider (or RelationshipClassifier)
  - If provided: use LLM for classifyRelation()
  - If not provided OR LLM fails: fall back to existing regex heuristics
```

### Current Call Flow (to preserve)

```
scallop-store.add({ detectRelations: true })
  → relationGraph.detectRelations(memory)
    → for each candidate: classifyRelation(new, existing, similarity)
      → [CURRENTLY] detectContradiction() / detectEnrichment() (regex)
      → [PHASE 19] RelationshipClassifier.classify() with regex fallback
```

### Anti-Patterns to Avoid
- **Breaking the fact-extractor path:** fact-extractor already passes `detectRelations: false` and uses its own batch classifier. Don't change this — it's more efficient (single batch call vs per-candidate calls).
- **Making LLM mandatory:** Other callers of `scallop-store.add()` may not have an LLM provider. Keep regex as fallback.
- **Duplicating the RelationshipClassifier:** Don't create a new classifier — use the existing one.
</architecture_patterns>

<dont_hand_roll>
## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| LLM classification prompt | New prompt | `RelationshipClassifier.classify()` | Already built, tested, handles edge cases |
| JSON parsing of LLM response | Custom parser | `RelationshipClassifier` internals | Handles malformed JSON, validation, defaults |
| Batch classification | Per-memory LLM calls | `classifyBatch()` if multiple candidates | Already optimized for token efficiency |
| Error handling | Custom try/catch | Existing fallback pattern | Returns `{ classification: 'NEW', confidence: 0.5 }` on any error |

**Key insight:** The RelationshipClassifier is already battle-tested. Phase 19 is about wiring, not building.
</dont_hand_roll>

<common_pitfalls>
## Common Pitfalls

### Pitfall 1: Breaking fact-extractor's Optimized Path
**What goes wrong:** Making RelationGraph's LLM classification run for fact-extractor facts too
**Why it happens:** fact-extractor passes `detectRelations: false` specifically to avoid double LLM calls
**How to avoid:** Only affects the `detectRelations: true` path in scallop-store.add()
**Warning signs:** Doubled LLM costs per fact extraction

### Pitfall 2: N+1 LLM Calls in detectRelations
**What goes wrong:** Calling `classify()` once per candidate memory = O(n) LLM calls
**Why it happens:** The current regex approach is synchronous and cheap; LLM is not
**How to avoid:** Batch candidates and use `classifyBatch()` instead of per-candidate `classify()`
**Warning signs:** Slow memory storage, high LLM cost for single memory add

### Pitfall 3: Losing Regex Fallback
**What goes wrong:** LLM provider not available → no relation detection at all
**Why it happens:** Making LLM required instead of optional
**How to avoid:** Keep regex as fallback when LLM is unavailable or fails
**Warning signs:** Tests fail when no LLM provider is configured
</common_pitfalls>

<code_examples>
## Code Examples

### Current Regex-Based Classification (to be replaced)
```typescript
// src/memory/relations.ts:267-304
private classifyRelation(
  newMemory: ScallopMemoryEntry,
  existingMemory: ScallopMemoryEntry,
  similarity: number
): DetectedRelation | null {
  // Uses detectContradiction() with 7 regex patterns
  // Uses detectEnrichment() with word overlap heuristic
  // Both are brittle and miss semantic relationships
}
```

### Existing LLM Classifier (to wire in)
```typescript
// src/memory/relation-classifier.ts
const classifier = createRelationshipClassifier(provider);
const result = await classifier.classify(
  { content: "Lives in Dublin", subject: "user", category: "location" },
  [{ id: "mem1", content: "Lives in Wicklow", subject: "user", category: "location" }]
);
// result: { classification: 'UPDATES', targetId: 'mem1', confidence: 0.9, reason: '...' }
```

### Established Fallback Pattern (from reranker)
```typescript
// src/memory/reranker.ts:91-93
try {
  const response = await provider.complete(request);
  llmScores = parseRerankResponse(responseText);
} catch {
  // LLM call failed — fall through to graceful fallback
}
```
</code_examples>

<sota_updates>
## State of the Art (2025-2026)

No external SOTA changes relevant — this is an internal refactoring using an already-built component.

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Regex detectContradiction/detectEnrichment | LLM RelationshipClassifier | Already built (v2.0) | More accurate, handles semantic relationships |

**Already implemented:**
- A-MEM paper's concept of LLM-guided relation typing → `relation-classifier.ts`
- Batch classification to reduce LLM calls → `classifyBatch()`
- Inference capabilities → `inferConnections()` (not yet wired)

**Phase 19 unlocks:** The `inferConnections()` method could be wired into the background gardener later to derive implicit facts from the relation graph (Phase 21 territory).
</sota_updates>

<open_questions>
## Open Questions

1. **Should `inferConnections()` be wired in Phase 19 or deferred?**
   - What we know: `RelationshipClassifier.inferConnections()` exists but isn't used anywhere
   - What's unclear: Whether it belongs in Phase 19 (relations) or Phase 21 (fusion engine)
   - Recommendation: Defer to Phase 21 — keep Phase 19 focused on replacing regex classification

2. **Should detectRelations batch all candidates in one LLM call?**
   - What we know: Current approach loops through candidates one-by-one (fine for regex, expensive for LLM)
   - What's unclear: Whether to refactor detectRelations to batch, or just call classify per candidate with low maxRelations
   - Recommendation: Use classifyBatch with all filtered candidates (max 5-10) in a single call
</open_questions>

<sources>
## Sources

### Primary (HIGH confidence)
- `src/memory/relation-classifier.ts` — existing LLM classifier, fully built and tested
- `src/memory/relations.ts` — regex-based classification to replace
- `src/memory/fact-extractor.ts` — integration pattern to follow
- `src/memory/reranker.ts` — fallback pattern to follow
- `src/memory/scallop-store.ts` — call site for detectRelations

### Secondary (MEDIUM confidence)
- None needed — all findings from direct codebase analysis
</sources>

<metadata>
## Metadata

**Research scope:**
- Core technology: Internal TypeScript refactoring
- Ecosystem: N/A (no external libraries)
- Patterns: Constructor injection, graceful fallback, batch LLM calls
- Pitfalls: Double LLM calls, N+1 queries, losing fallback

**Confidence breakdown:**
- Standard stack: HIGH — all components already exist in codebase
- Architecture: HIGH — following established patterns from reranker and fact-extractor
- Pitfalls: HIGH — derived from direct code analysis
- Code examples: HIGH — from actual codebase files

**Research date:** 2026-02-10
**Valid until:** N/A (internal codebase, no external dependencies to go stale)
</metadata>

---

*Phase: 19-llm-memory-relations*
*Research completed: 2026-02-10*
*Ready for planning: yes*
