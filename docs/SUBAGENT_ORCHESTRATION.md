# Durable sub-agent orchestration

ScallopBot delegates work through the native `spawn_agent` and `check_agents` tools. The runtime borrows the strongest practical ideas from OpenClaw-style task ledgers and Hermes-style isolated workers while preserving ScallopBot's evidence and privacy boundaries.

## Behavior

- Background completion is written to a durable leased outbox, injected into parent context as an internal receipt, and pushed as a short outcome message. Scratchpads and think tags are removed.
- `tasks` fan-out is capacity-reserved as a batch. If preparation fails, no child begins execution and prepared sessions are archived with an audit status.
- `context_mode` is `isolated`, `brief`, or `fork`. Isolated workers receive no user profile, memories, channel instructions, skill-management instructions, or unrelated transcript.
- `role=orchestrator` may create children only up to `SUBAGENT_MAX_SPAWN_DEPTH`. Leaf workers cannot delegate.
- `check_agents` supports `list`, `info`, `log`, `cancel`, `steer`, and `followup`.
- `workspace_mode=worktree` runs coding work in a detached Git worktree and produces a conflict-checked binary patch without creating a branch.
- `workflow=coding` runs an implementer followed by an independent reviewer/tester in that worktree.
- Success uses a structured result with evidence, artifacts, changed files, tests, blockers, next actions, and explicit acceptance status. Runtime failures always override model-authored success.
- Liveness is based on time since model/tool progress. The default hard wall-clock limit is disabled; token, cost, iteration, idle, concurrency, and nesting budgets remain enforced.
- When gated self-evolution is enabled, clean multi-tool child workflows feed its existing privacy filter, held-out fitness evaluation, documentation-only skill promotion, usage tracking, and rollback loop.

## Deterministic verification

Run:

```bash
npm run typecheck
npm test -- --run src/subagent src/channels/api.test.ts
npm --prefix web run build
```

The regression suite measures these boundaries:

| Boundary | Previous behavior | Required behavior/test |
|---|---|---|
| Async completion | Waited for a future parent iteration | Durable unique outbox row and exclusive lease |
| Restart | Active work was called failed | `lost`/blocked; never inferred success; user receives a recovery notice |
| Batch | One task per call; capacity could race | Whole-batch reservation before any execution |
| Context | One enriched context shape | Three explicit modes; isolated prompt excludes profile/memory |
| Nesting | Always forbidden | Leaf denied; orchestrator allowed only below configured depth |
| Coding isolation | Shared workspace | Detached worktree; committed and uncommitted changes captured; parent remains unchanged |
| Completion truth | Free-form prose | Runtime status wins; requested acceptance must explicitly pass |
| Thought privacy | Child summary could be treated as user text | Minimal worker prompt plus output reasoning removal |
| Control | Status/cancel only | Info, logs, cancel, steer, follow-up |
| Visibility | No dashboard task view | Authenticated task rail with hierarchy, status, evidence, blockers, controls |

Transport delivery time still depends on the configured channel. The gateway checks ready completion leases once per second; it does not claim that Telegram or a disconnected browser can provide exactly-once network delivery.
