# Intelligence roadmap and evidence

This document describes the eleven public, bot-agnostic improvements added to
ScallopBot and the checks that must pass before they are described as better.
It contains no private conversation data, chat identifiers, deployment
addresses, or bot-specific configuration.

## What changed

| # | Area | Improvement | Evidence gate |
|---:|---|---|---|
| 1 | Model routing | Complexity tiers now choose distinct primary models, preserve configured fallbacks, track fallback cost, and avoid repeatedly probing unhealthy background providers. | `src/routing/routing-quality.test.ts` |
| 2 | Memory retrieval | BM25 is unioned with an independent, bounded SQLite LSH semantic candidate set and exact cosine re-ranking. MMR can reduce duplicate results. | `src/memory/retrieval-quality.test.ts`, `src/memory/semantic-index.test.ts`, `npm run benchmark:memory` |
| 3 | Proactive messages | Generators must return a structured `userFacingMessage`. Independent authorship provenance keeps model/tool-created schedules on the rendering path even when the user initiated them; only proven literal user text can bypass rewriting. Internal plans are rejected at generation and delivery, recurring items retain provenance, and feedback attribution is channel/user scoped. | `src/proactive/*.test.ts`, `src/memory/proactive-evaluator.test.ts` |
| 4 | Tool safety | Allow/deny policy is enforced again at dispatch, including workflows and subagents. Skill environments use an allowlist and logs/traces redact secrets. | `src/agent/tool-policy-dispatch.test.ts`, `src/skills/executor.test.ts`, `src/security/redaction.test.ts` |
| 5 | Verified goals | Hierarchical goals have persistent budgets, evidence, independent completion checks, continuation across turns, and actual subagent cost accounting. | `src/goals/verified-goal.test.ts`, `src/goals/skill.test.ts` |
| 6 | Context-efficient workflows | `execute_workflow` executes a validated DAG while keeping unselected tool output and hidden errors out of the model-visible transcript. Output/error bytes are bounded and caller policy is rechecked immediately before every node. | `src/workflow/executor.test.ts` |
| 7 | MCP | The bundled MCP skill supports progressive stdio discovery and calls with owner-only config, explicit per-server tool allowlists, advertised-schema validation, scoped-secret redaction, bounded I/O, and process-tree cleanup. | `src/skills/bundled/mcp/mcp.test.ts` |
| 8 | Evidence-gated evolution | Complete capped procedures are replayed on held-out tasks, scored from actual baseline/candidate outputs, deterministically and adversarially safety-reviewed, promoted transactionally, and watched for rollback. | `src/evolution/fitness.test.ts`, `src/evolution/optimizer.e2e.test.ts`, `src/evolution/version-ledger.test.ts` |
| 9 | Durable workers | Board work uses leases, heartbeats, retry limits, crash reclaim, result persistence, and duplicate-execution guards. Subagents default to a read-only tool set. | `src/board/durable-workers.test.ts`, `src/proactive/scheduler-durable-task.test.ts` |
| 10 | Measurement | A deterministic scorecard collects before/after behavior for every roadmap dimension. The command fails if a required delta regresses. | `npm run benchmark:intelligence` |
| 11 | Automatic procedural skills | Successful multi-tool workflows and repeated failures can propose bounded documentation-only skills; a corrected successful rerun becomes new reusable evidence. Target ownership, crash-safe file swaps, real usage/provenance, and stale/archive/restore curation are enforced. | `src/evolution/units.test.ts`, `src/evolution/skill-store-hardening.test.ts`, `src/evolution/optimizer.e2e.test.ts` |

## Automatic skill improvement loop

The design follows the useful parts of the Hermes skill lifecycle: distill a
repeatable workflow after successful multi-tool work or a useful correction,
track whether the resulting skill is actually used, and curate unused
agent-created skills. Hermes documents its automatic skill creation and
management in its [skills guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/)
and usage-driven cleanup in its [curator guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator/).

ScallopBot's loop is deliberately evidence-gated:

1. Capture a minimal signal after a successful 5+ tool workflow or a failure.
   A user-corrected rerun is learned only if the corrected workflow succeeds;
   the earlier failed behavior is not treated as a recipe. Task previews and
   raw session text are excluded unless the operator explicitly consents, and
   any included evidence is redacted. Context-free creation proposals remain
   pending rather than inventing a generic procedure.
2. Split evidence into reflection and holdout cases. The proposer never sees
   the holdout set.
3. Generate one capped procedural `SKILL.md`. It must use a minimal, plain
   documentation-only frontmatter contract and cannot collide with any existing
   skill. Autonomous patches are limited to curator-owned documentation skills;
   bundled, native, executable, and user-authored skills are immutable. Machine-
   authored executable scripts are rejected because the runtime does not yet
   provide OS isolation.
4. Replay both the old and proposed procedures on every holdout task, then have
   a fail-closed evaluator score the actual outputs.
5. Run deterministic secret/PII/dangerous-content scans and an adversarial
   safety review. Any unavailable or malformed required evaluation rejects the
   candidate.
6. Promote only when the candidate clears the mandatory fitness margin. Prompt
   and version-ledger writes share one SQLite transaction. Skill replacements
   use owner-only journals and recover to a complete old-or-new tree after a
   write failure, process crash, or restart; registry/database failures are
   compensated.
7. The model explicitly selects a documentation skill with `load_procedure`;
   that successful load records real use. Post-promotion failures can trigger
   rollback, while unused agent-created skills move from active to stale to a
   recoverable archive.

This improves the agent through reviewed procedural memory, not by changing
model weights. The engine is off by default (`EVOLUTION_ENABLED=false`).

## Reproducing the measurements

```bash
npm run benchmark:intelligence
npm run benchmark:memory
npm run typecheck
npm test -- --run
npm run lint
npm run build
git diff --check
```

## Reference verification run (2026-07-10)

The dynamic scorecard executed all before/after probes and passed 11/11:

| Probe | Former behavior | Candidate behavior |
|---|---:|---:|
| Distinct model-tier primaries | 1 | 3 |
| Semantic-only target recall | 0 | 1 |
| Proactive attribution precision | 0.40 | 1.00 |
| Secret-bearing channels exposed to an unscoped tool | 2 | 0 |
| Unverified goal completion accepted | 1 | 0 |
| Hidden workflow bytes returned to the model | 2,008 | 0 |
| Working MCP lifecycle operations | 0 | 3 |
| Unevaluated mutations promoted | 1 | 0 |
| Expired leases recoverable after restart | 0 | 1 |
| Substantive dimensions with dynamic measurement | 0 | 10 |
| Observed automatic-skill lifecycle stages | 1 | 5 |

The 10,000-memory, 768-dimension reference run measured:

The reference host was Darwin/arm64; these are not Raspberry Pi timings. The
same command is intended to be run on the target Pi before deployment.

| Retrieval path | p50 latency | Retained heap | Exact target recall |
|---|---:|---:|---:|
| Full vector scan | 260.06 ms | 68.44 MB | 1.00 |
| Bounded indexed union | 16.89 ms | 13.54 MB | 1.00 |

That run was 15.40x faster and used 5.05x less retained heap. Across 100
perturbed queries at average cosine 0.849, indexed candidate recall was 0.97
(legacy lexical-gated recall was 0). One-time backfill took 778 ms and the
index added 9.82 MB. The benchmark exits non-zero below 2x latency improvement,
2x heap improvement, 0.95 perturbed-query recall, or 1.00 exact recall.

Repository verification passed 161 test files / 2,310 tests, with one existing
slow timeout test intentionally skipped. The focused intelligence command
passed 25 files / 221 tests plus that skip. TypeScript, repository-wide lint,
the production build, and the whitespace audit all passed.

`benchmark:memory` generates a deterministic 10,000-memory corpus with
768-dimensional embeddings. It reports exact/full-scan and indexed latency,
heap, candidate count, semantic recall, migration time, and disk overhead.
Absolute timing depends on the host, so release decisions should use repeated
runs and require both bounded memory and a non-regressing latency ratio.

## Security boundary

Tool policies, least-privilege subprocess environments, redaction, and blocking
machine-authored scripts are defense-in-depth improvements. They are not an OS
sandbox. Human-authored shell skills and configured MCP servers can still access
whatever the ScallopBot process account can access. Run the service as a
dedicated low-privilege user or inside a container, pin MCP server packages, and
keep destructive/network tools denied on public channels.
