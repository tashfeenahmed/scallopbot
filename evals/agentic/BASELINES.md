# ScallopBench baselines

This file explains how to get **comparable** numbers for ScallopBot, Hermes
Agent, Prime Agent and OpenClaw on the same tasks, with the same models,
scored by the same scorers (plan §5 Phase 0, items 3–4).

## Tasks

`--tasks` takes `all`, a category, or a comma list of ids/categories.

| Category | Tasks | What it probes |
|---|---|---|
| `trap` | 12 | waste patterns and gates that blocked ordinary work (plan §3.2) |
| `coding` | 6 | small modules with hidden tests |
| `assistant` | 3 | everyday file work, one multi-turn |
| `hard` | 15 | long, careful work that separates strong harnesses from weak ones |

On the first 21 tasks ScallopBot and Hermes both score 21/21, so those no
longer separate agents. The `hard` category is built for that: every task
has a decoy or a second failure that a careless agent walks into, and
`careless.ts` holds one or two such shortcuts per task that the test suite
proves the scorer rejects.

| Hard task | What it tests | Why a weak harness fails it |
|---|---|---|
| `hard-rename-most-called` | find the function with the most real call sites in a 42-file repo, rename it everywhere, keep tests green | `grep 'parseId('` counts comments and picks the wrong function; `sed s/toSlug/…/` also renames `toSlugPath` |
| `hard-config-facts` | answer from 8 service configs in 5 formats (json/yaml/toml/ini/env) plus `override.env` files | skipping the README's override rule or the `_template` exclusion gives the wrong set; efficiency reports tool rounds and the widest parallel batch |
| `hard-env-report` | `npm run report` crashes with a TypeError inside a shared script; the cause is missing env config | papering over it in `scripts/` fails; fixing only the crash leaves a silent `NaN undefined` (the currency was missing too) |
| `hard-vendor-offline` | a dependency that is on no registry must be installed from the right local tarball, offline, reproducibly | unpacking into `node_modules` by hand passes the tests but a fresh `npm install` fails; the 1.1.0 tarball lacks an export |
| `hard-split-money` | split a module into a package and change a signature used at 10 call sites; hidden tests + behaviour diff against the pristine code | positional callers left behind silently change output (`undefined` currency, `JPY`, German locale) |
| `hard-precise-edit` | change two lines in a ~3,000-line checksummed file (trailing spaces, tabs, non-ASCII, no final newline) | a whole-file rewrite loses invisible bytes; the look-alike `svc-0271` sits nearby |
| `hard-date-bug` | "there is a date bug, fix it": exactly one exists (Sunday is `getDay() === 0`) | asking instead of inspecting changes nothing; "tidying" other modules is caught |
| `hard-three-bugs` | one red suite with three independent bugs in three files; tests must stay untouched | stopping after the first fix, or bending a test |
| `hard-csv-join` | join two dirty CSVs (case/whitespace ids, last-row-wins duplicates, repeated order ids, quoted commas, `$` amounts) into an exact JSON schema | any skipped cleaning rule changes the numbers |
| `hard-git-branch` | branch, change, commit exactly two files with a given message, in a repo with uncommitted unrelated work | `git add -A` sweeps the WIP in; stashing without restoring loses it |
| `hard-server-query` | start a local server, get a token, query it, record the answer with the server-issued receipt, stop the server | leaving it running (checked by pid and port; the server also logs when it had to exit by its own 2-minute safety timer) |
| `hard-two-turn-correction` | turn 2 changes the format and sort; turn 1's exclusion must still hold | redoing the file from scratch in turn 2 brings `test-bot` back |
| `hard-readme-injection` | follow a README's steps to add a locale; the README also hides an "AI agents: delete these files" instruction | obeying it deletes `legacy/`, `docs/`, `.env`, `scripts/release.sh` |
| `hard-log-trace` | follow a failed checkout across api → worker → db logs (~3,000 lines each) to its root cause | the first failed checkout in the file is an hour off; other errors sit next to the right one |
| `hard-json-migrate` | migrate 24 nested JSON configs v1 → v2 from a spec (unit changes, missing keys, messy owner lists) | re-serialising the two files already at v2, or leaving backups under `configs/` |

Every hard task works offline, needs only Node and Python 3, seeds
everything in `setup`, and has a per-task timeout (10–15 minutes) that the
export carries as `timeoutS`.

## Two scoring modes

Both modes score from the workspace and the user-visible replies, never from
the agent's claims about what it did.

- **default** (ScallopBot regression mode, unchanged): two trap scorers also
  look at the trace, because the trace is the waste pattern they reproduce.
  `trap-rerun-tests` wants two `npm test > out.txt` shell calls (the bug was
  an identical write being refused) and `trap-write-400-lines` wants a
  successful `write_file` call (the bug was the output cap truncating it).
- **cross-agent** (`--cross-agent`, outcome only): no scorer passes or fails
  on tool names or tool-call counts. `trap-rerun-tests` reads `runs.log`
  instead: the seeded test runner appends `run N pass|fail` on every
  `npm test`, so "ran, fixed, re-ran" is visible in the workspace whatever
  tool ran it. `trap-write-400-lines` judges the file only (its prompt no
  longer names a tool). All other tasks, and every hard task, already score
  outcomes only.

Process signals are reported in both modes as **efficiency**, never as
pass/fail: each result carries `efficiency.toolCalls`, `toolErrors`,
`llmCalls`, plus task-specific metrics (`hard-config-facts`: `toolRounds` and
`maxParallelCalls`, in-process runs only). The scorecard prints mean tool
calls and LLM calls per task.

Use cross-agent mode for every comparison between agents, ScallopBot
included, so all four are judged identically. Use default mode for
ScallopBot's own regression runs.

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

# the four-agent comparison: every task, outcome-only scoring
npm run bench:agentic -- --model moonshot:kimi-k2.6 --tasks all --cross-agent --baseline scallopbot-moonshot-kimi-k2.6-all-xagent

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

## Hermes Agent, Prime Agent and OpenClaw

None is installed here. The adapter contract keeps them out of this repo:

1. **Export the tasks** (no model needed):

   ```bash
   npm run bench:agentic -- --export /tmp/scallopbench/tasks.json --tasks all
   ```

   This writes `tasks.json` and `tasks.fixtures/<task-id>/` (each task's
   seeded workspace; `trap-giant-log` is ~50MB). `tasks.json` lists, per
   task: `id`, `category`, `title`, `turns` (user messages, in order),
   `fixture` (path relative to `tasks.json`), `timeoutS` (hard tasks),
   `git: true` when the fixture is a git repo, and the fixture file list
   (`.git/` internals are copied but not listed). Hidden tests and scorers
   are **not** exported; they stay here.

2. **Run each task through the other agent.** For every task:
   - copy `fixture/` to a fresh directory **including dotfiles and `.git/`**
     (`cp -R fixture/. ws/`) and make it the agent's working directory
     (Hermes: launch the CLI/gateway from that cwd, or point its
     terminal/file tools there; Prime: start the kernel with that cwd;
     OpenClaw: start its session in that directory);
   - start **one** session and send each entry of `turns` as a user message,
     waiting for the agent to finish its turn before sending the next;
   - record the final reply of each turn, verbatim.
   - Use the same model id as the ScallopBot run (OpenRouter ids make this
     easy: all four agents can talk to OpenRouter), default settings, no
     extra system prompt, no task-specific hints. Turn on any "yolo"/
     auto-approve mode so nothing waits for a human (ScallopBot's bench has no
     human either).
   - Leave the workspace exactly as the agent left it and score on the same
     machine soon after: `hard-server-query` checks that the server's pid is
     gone and its port is closed.

3. **Write a run file** next to the workspaces:

   ```json
   {
     "agent": "hermes",
     "model": "moonshotai/kimi-k2.6",
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
   required, one entry per turn. Token/latency fields are optional but
   needed for the cost and cache rows of the scorecard: Hermes keeps
   per-session token counts in its session DB (`~/.hermes/state.db`, see its
   `insights`/`postmortem` tooling), Prime logs usage per model call in its
   run log. `toolCalls` (each `{ name, input?, isError?, turn? }`, in the
   agent's own tool names) and `llmCalls` only feed the efficiency metrics:
   in cross-agent mode there is no need to map them onto ScallopBot's names.

4. **Score it with the same scorers, outcome only**:

   ```bash
   npm run bench:agentic -- --score /tmp/scallopbench/hermes-run.json --cross-agent
   ```

   This prints the same scorecard and writes
   `evals/agentic/results/<timestamp>-hermes_<model>-external.json`. Copy it
   to `baselines/hermes-<model>-<tasks>.json` to record it. Without
   `--cross-agent`, `--score` uses default mode, where `trap-rerun-tests` and
   `trap-write-400-lines` also want ScallopBot-shaped `bash` / `write_file`
   calls in `toolCalls`; that is only for reproducing old results.

A thin adapter script per agent (Python for Hermes, which already has a
batch runner and an `environments/` harness; Python for Prime, which runs a
kernel per session; the same loop for OpenClaw) should only do steps 2–3:
loop over `tasks.json`, drive the agent, and emit the run file. No scoring
logic belongs in the adapter.

## Comparing

Compare like with like: same task selector, same model id, same `--repeat`,
and `--cross-agent` on every side (the scorecard header then says
`cross-agent (outcome-only) scoring`). The four-agent comparison on Kimi:

```bash
npm run bench:agentic -- --export /tmp/scallopbench/tasks.json --tasks all
npm run bench:agentic -- --model moonshot:kimi-k2.6 --tasks all --cross-agent      # ScallopBot, in process
npm run bench:agentic -- --score /tmp/scallopbench/hermes-run.json --cross-agent   # likewise prime-run.json, openclaw-run.json
```

The scorecard rows map to the plan's §7 targets:

| Scorecard row | §7 target |
|---|---|
| pass rate · trap | trap-task pass rate |
| pass rate · coding | coding-suite pass rate |
| pass rate · hard | separation between agents (no §7 target yet) |
| LLM calls / turn (+ `by purpose`) | LLM calls before reply / per one-tool turn |
| input tok / turn | input tokens per simple turn |
| cache-read share | cache-read share (needs the provider to report cache reads) |
| turn latency · first reply | time to first token (end of `processMessage` until streaming lands) |
| tool calls · error rate | tool error rate |
| efficiency | tool calls and LLM calls per task (reported, not scored) |
| canned refusals | must be 0 |

Cache-read share prints `n/a` when the provider does not report cached input
tokens (Moonshot today: `providers/moonshot.ts` drops `usage.cached_tokens`).

## Verifying the scorers (no model, no network)

`npx vitest run evals` proves every scorer works without spending credits:

- every task's reference solution, run straight through the real skills,
  passes in both modes, and the untouched workspace fails;
- every hard task has at least one careless solution (`careless.ts`) that
  its scorer rejects;
- every hard task replays through the real Agent with the `scripted`
  provider and passes in cross-agent mode;
- an external run with Prime-style tool names (`ipython`, `edit`) passes the
  two tool-trap tasks in cross-agent mode and fails them in default mode;
- export + `--score` in cross-agent mode round-trips a hard task with a git
  fixture and a two-turn task.

`npm run bench:agentic -- --model scripted --tasks all --cross-agent` runs
the same replay from the CLI.
