# ScallopBench baselines

This file explains how to get **comparable** numbers for ScallopBot, Hermes
Agent and Prime Agent on the same tasks, with the same models, scored by the
same scorers (plan §5 Phase 0, items 3–4).

## What counts as a baseline

A baseline is a results JSON committed under `evals/agentic/baselines/`. It
records the model, the commit it ran on, the options, the scorecard and every
task trace. Name it `<agent>-<when>-<model>-<tasks>.json`, for example
`scallopbot-before-moonshot-kimi-k2.6-traps.json`.

The "before" number for the Phase 1+ rebuild is
`baselines/scallopbot-before-moonshot-kimi-k2.6-traps.json`: the unmodified
agent loop (commit `89b2808`; this branch only adds the cost `purpose`
column) on the trap tasks, Kimi with thinking on (`KIMI_THINKING_ENABLED`).
The repo default `kimi-k2.5` now returns 404 from Moonshot, so the run uses
`kimi-k2.6`, the closest K2-family model the key can reach (the provider's
K2-specific thinking/temperature handling applies to it unchanged).

## ScallopBot

```bash
# one model, one category
npm run bench:agentic -- --model moonshot:kimi-k2.6 --tasks trap --baseline scallopbot-before-moonshot-kimi-k2.6-traps

# the model matrix (strong / mid / weak — the weak model is the signal)
npm run bench:agentic -- \
  --models openrouter:anthropic/claude-sonnet-4.5,moonshot:kimi-k3,openrouter:qwen/qwen3.6-plus \
  --tasks all --concurrency 4 --repeat 3
```

Keys come from the environment or the nearest `.env` above the working
directory (`MOONSHOT_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `LOCAL_BASE_URL`). `AGENT_WORKSPACE` is ignored: every
task runs in its own temp dir.

Defaults that differ from production, on purpose:

| Setting | Bench | Production | Why |
|---|---|---|---|
| `maxIterations` | 40 (`--max-iterations`) | 100 | bounds cost per task |
| memory store, reranker, fact extraction | off | on | the bench measures the agent loop; memory has LoCoMo |
| local `~/.scallopbot/skills` | not loaded | loaded | hermetic, comparable across machines |
| `send_message` | recorded, not delivered | Telegram/API | no channels |

Everything else is production wiring: real `Agent`, bundled skills via the
real `SkillExecutor`, `Router` + `CostTracker`, and the shared `OutcomeBrain`
(`--no-outcome-brain` turns it off for A/B runs).

## Hermes Agent and Prime Agent

Neither is installed here. The adapter contract keeps them out of this repo:

1. **Export the tasks** (no model needed):

   ```bash
   npm run bench:agentic -- --export /tmp/scallopbench/tasks.json
   ```

   This writes `tasks.json` and `tasks.fixtures/<task-id>/` (each task's
   seeded workspace; `trap-giant-log` is ~50MB). `tasks.json` lists, per
   task: `id`, `category`, `title`, `turns` (user messages, in order),
   `fixture` (path relative to `tasks.json`) and the fixture file list.
   Hidden tests and scorers are **not** exported; they stay here.

2. **Run each task through the other agent.** For every task:
   - copy `fixture/` to a fresh directory and make it the agent's working
     directory (Hermes: launch the CLI/gateway from that cwd, or point its
     terminal/file tools there; Prime: start the kernel with that cwd);
   - start **one** session and send each entry of `turns` as a user message,
     waiting for the agent to finish its turn before sending the next;
   - record the final reply of each turn, verbatim.
   - Use the same model id as the ScallopBot run (OpenRouter ids make this
     easy: all three agents can talk to OpenRouter), default settings, no
     extra system prompt, no task-specific hints. Turn on any "yolo"/
     auto-approve mode so nothing waits for a human (ScallopBot's bench has no
     human either).

3. **Write a run file** next to the workspaces:

   ```json
   {
     "agent": "hermes",
     "model": "qwen/qwen3.6-plus",
     "results": [
       {
         "taskId": "trap-clean-dist",
         "workspace": "ws/trap-clean-dist",
         "replies": ["Removed dist/."],
         "toolCalls": [{ "name": "terminal", "input": { "command": "rm -rf dist" } }],
         "llmCalls": 2,
         "inputTokens": 14000,
         "outputTokens": 300,
         "cachedInputTokens": 9000,
         "durationMs": 8400
       }
     ]
   }
   ```

   `workspace` is absolute or relative to the run file. `replies` is
   required. Token/latency fields are optional but needed for the cost and
   cache rows of the scorecard: Hermes keeps per-session token counts in its
   session DB (`~/.hermes/state.db`, see its `insights`/`postmortem` tooling),
   Prime logs usage per model call in its run log. `toolCalls` is only used
   by the two scorers that look at the trace (`trap-rerun-tests` counts the
   `npm test > out.txt` runs and expects a `bash`-shaped `command` input;
   `trap-write-400-lines` checks for a `write_file` call) — map the other
   agent's tool names onto `bash` / `write_file` when you write the run file.

4. **Score it with the same scorers**:

   ```bash
   npm run bench:agentic -- --score /tmp/scallopbench/hermes-run.json
   ```

   This prints the same scorecard and writes
   `evals/agentic/results/<timestamp>-hermes_<model>-external.json`. Copy it
   to `baselines/hermes-<model>-<tasks>.json` to record it.

A thin adapter script per agent (Python for Hermes, which already has a
batch runner and an `environments/` harness; Python for Prime, which runs a
kernel per session) should only do steps 2–3: loop over `tasks.json`, drive
the agent, and emit the run file. No scoring logic belongs in the adapter.

## Comparing

Compare like with like: same task selector, same model id, same `--repeat`.
The scorecard rows map to the plan's §7 targets:

| Scorecard row | §7 target |
|---|---|
| pass rate · trap | trap-task pass rate |
| pass rate · coding | coding-suite pass rate |
| LLM calls / turn (+ `by purpose`) | LLM calls before reply / per one-tool turn |
| input tok / turn | input tokens per simple turn |
| cache-read share | cache-read share (needs the provider to report cache reads) |
| turn latency · first reply | time to first token (end of `processMessage` until streaming lands) |
| tool calls · error rate | tool error rate |
| canned refusals | must be 0 |

Cache-read share prints `n/a` when the provider does not report cached input
tokens (Moonshot today: `providers/moonshot.ts` drops `usage.cached_tokens`).
