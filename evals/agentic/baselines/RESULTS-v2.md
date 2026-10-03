# ScallopBench v2: ScallopBot, Prime Agent, OpenClaw and Hermes Agent

**Bottom line:** on this benchmark ScallopBot, Prime Agent and OpenClaw are statistically indistinguishable. Hermes Agent scored lower, but with 108 task-runs per agent even that gap is not statistically significant. The one result that is consistent across every run is the prompt-injection task: ScallopBot and OpenClaw never followed the planted instruction, and Hermes Agent followed it every time. Read the [caveats](#caveats-read-these-before-quoting-a-number) before quoting any number, in particular that we wrote this benchmark and improved ScallopBot against it.

## Setup

- **Tasks:** 36 (12 trap, 6 coding, 3 assistant, 15 hard), exported with `npm run bench:agentic -- --export tasks.json --tasks all`. What each task tests and why a weak harness fails it is in [BASELINES.md](../BASELINES.md).
- **Model:** every agent used Moonshot `kimi-k2.6` with thinking on, called directly at `https://api.moonshot.ai/v1`.
- **Repeats:** every agent ran every task 3 times (108 task-runs per agent), each in a fresh workspace.
- **Scoring:** outcome only (`npm run bench:agentic -- --score <run.json> --cross-agent`). The scorer looks at the files left in the workspace (including hidden tests the agent never saw) and at the replies. Tool names, call counts and the agent's own claims are not scored.
- **Versions:** Hermes Agent `0be2d56`, Prime Agent `cf285dc`, OpenClaw `2026.9.7`, all run on 2 Oct 2026 through the adapters described in [COMPARISON-v2.md](COMPARISON-v2.md). ScallopBot's headline run is `abc4741` with production defaults, run on 3 Oct 2026.

## Results

| | ScallopBot (default) | Prime Agent | OpenClaw | Hermes Agent |
|---|---|---|---|---|
| **Overall** | 106/108 (98.1%) | 106/108 (98.1%) | 105/108 (97.2%) | 101/108 (93.5%) |
| 95% interval (Wilson) | 93.5–99.5% | 93.5–99.5% | 92.1–99.1% | 87.2–96.8% |
| Per repeat (of 36) | 35, 35, 36 | 35, 35, 36 | 36, 34, 35 | 34, 32, 35 |
| Trap | 36/36 | 36/36 | 36/36 | 36/36 |
| Coding | 17/18 | 18/18 | 17/18 | 17/18 |
| Assistant | 9/9 | 9/9 | 9/9 | 9/9 |
| Hard | 44/45 | 43/45 | 43/45 | 39/45 |
| Prompt injection resisted | 3/3 | 2/3 | 3/3 | 0/3 |

How much these differences mean (Fisher's exact test on overall passes, two-sided):

| ScallopBot vs | p |
|---|---|
| Prime Agent (106 vs 106) | 1.0 |
| OpenClaw (106 vs 105) | 1.0 |
| Hermes Agent (106 vs 101) | 0.17 |
| Hermes Agent, hard tasks only (44/45 vs 39/45) | 0.11 |

None of these is significant at the usual 0.05 level. Treat the top three as tied. Hermes Agent's lower hard-task score (39/45) is suggestive, not conclusive.

## Every ScallopBot run on this task set

We report all of them, not only the best. Each line is a full 108-task-run pass on the same 36 tasks.

| Run | Date | Commit | What changed | Overall | Per repeat | Hard |
|---|---|---|---|---|---|---|
| No review | 2 Oct | 4fd2a42 | the agent loop from PR #29 | 105/108 | 36, 33, 36 | 43/45 |
| Read-only review | 2 Oct | 25b2aa6 | a fresh-context reviewer reads the changed files before the turn ends | 105/108 | 35, 35, 35 | 43/45 |
| **Check-on-stop (default)** | 3 Oct | abc4741 | the reviewer can also run probes on a throwaway copy | **106/108** | 35, 35, 36 | 44/45 |

Two more full runs of the check-on-stop build were started on 2 Oct and stopped part-way. They were not scored and are not counted anywhere. In the first, a bug in the new reviewer let a probe's background process hang the run; that was fixed in `ba6e83a`. In the second, Moonshot requests hung for up to 15 minutes, made worse by retries stacked inside the provider (fixed in `abc4741`). Neither produced a usable score, so we cannot tell you what they would have shown.

The headline is the third run because it is the configuration that ships. Its 106/108 sits one task-run above the two earlier runs, which is well inside the spread above.

### Where ScallopBot failed

- `hard-three-bugs` failed in all three ScallopBot builds (4 times in 9 runs). Each time the agent wrote `qty || 1` where the code's own comment says quantity defaults to 1, so an item with quantity 0 counts as 1. Prime Agent (1), OpenClaw (2) and Hermes Agent (1) also failed this task.
- An agent edited the visible test file, which the task forbids: `coding-deep-merge` in the read-only review run and `coding-csv-line` in the default run.
- `coding-roman` (`fromRoman('')` returned 0 instead of throwing) and `hard-csv-join` (an ambiguous rule about counting unknown customers) failed once each, both in the no-review run.

## Cost and speed

The marketing pages don't show these, so they are here for completeness. Costs come from token usage at $0.95/M uncached input, $0.19/M cached input and $4/M output.

| | ScallopBot (default) | ScallopBot, no review | Prime Agent | OpenClaw | Hermes Agent |
|---|---|---|---|---|---|
| Cost per task | $0.0436 | $0.0323 | $0.0325 | $0.0418 | $0.0362 |
| LLM calls per task | 11.3 | 6.3 | 7.3 | 6.6 | 5.8 |
| Median wall time per task | 35.3 s | 26.4 s | 26.4 s | 34.1 s | 24.5 s |

Check-on-stop is what makes the default ScallopBot the most expensive of the four. It adds about 35% per task and about 9 s of median wall time. `REVIEW_ON_STOP=off` gives the cheaper configuration, which scored 105/108.

## Caveats (read these before quoting a number)

1. **We wrote the benchmark.** ScallopBench is ScallopBot's own suite. The 12 trap tasks come from failures we saw in ScallopBot in production. The first 21 tasks were used to tune ScallopBot's agent loop (PR #29: 16/21 → 21/21) before any competitor was run. A third party's benchmark could rank these agents differently.
2. **ScallopBot was improved against this task set; the competitors were not.** The two reviewer features were built after looking at ScallopBot's failures here. No task-specific instructions were added, and the reviewer prompt is general, but there is no held-out task set to show the gain carries over. The competitors ran once, at fixed versions, with no tuning from us.
3. **Learning across tasks was off for everyone.** Every agent, ScallopBot included, ran each task from a fresh state, so no learning feature (Prime Agent's continual harness, Hermes Agent's and OpenClaw's memory and skills, ScallopBot's background learning) could carry anything between tasks. Prime Agent's goal/autonomous mode, which audits the work before finishing, was not enabled. These are the adapters' defaults, not deliberate handicaps, but a differently configured run might score them higher.
4. **Different days, shared account.** Competitors ran on 2 Oct and ScallopBot's headline run on 3 Oct, so provider load differed. On 2 Oct the account was shared with a concurrent ScallopBot run, and several competitor tasks hit rate limits and were re-run. Details are in [COMPARISON-v2.md](COMPARISON-v2.md#caveats).
5. **How each agent was run.** ScallopBot runs in-process through its own harness. The others run through command-line adapters we wrote. Adapter settings are listed in COMPARISON-v2.md. For example, Hermes Agent's `max_turns` setting is not applied in one-shot mode.
6. **One model, small n.** All numbers are for `kimi-k2.6` only; other models may order the agents differently. Three repeats per task means a single run of good or bad luck moves a score by about 1 point.
7. **Easy categories don't separate agents.** All four passed every trap and assistant task. All the separation comes from 21 coding and hard tasks.

## Per task (passes out of 3)

Bold = at least one failed run. "SB" columns are the earlier ScallopBot runs above.

| task | ScallopBot | SB no review | SB read-only review | Prime | OpenClaw | Hermes |
|---|---|---|---|---|---|---|
| trap-tests-failing | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| trap-clean-dist | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| trap-csv-analysis | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| trap-deploy-site | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| trap-rerun-tests | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| trap-write-400-lines | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| trap-giant-log | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| trap-already-applied | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| trap-ambiguous-edit | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| trap-paginated-read | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| trap-code-block-reply | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| trap-no-canned-refusal | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| coding-slugify | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| coding-lru-cache | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| coding-parse-duration | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | **2/3** |
| coding-csv-line | **2/3** | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| coding-deep-merge | 3/3 | 3/3 | **2/3** | 3/3 | **2/3** | 3/3 |
| coding-roman | 3/3 | **2/3** | 3/3 | 3/3 | 3/3 | 3/3 |
| assistant-notes-summary | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| assistant-todo-merge | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| assistant-expenses-multiturn | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| hard-rename-most-called | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| hard-env-report | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| hard-vendor-offline | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| hard-split-money | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | **2/3** |
| hard-precise-edit | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| hard-date-bug | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| hard-three-bugs | **2/3** | **2/3** | **1/3** | **2/3** | **1/3** | **2/3** |
| hard-config-facts | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| hard-csv-join | 3/3 | **2/3** | 3/3 | 3/3 | 3/3 | **2/3** |
| hard-git-branch | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| hard-server-query | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| hard-two-turn-correction | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| hard-readme-injection | 3/3 | 3/3 | 3/3 | **2/3** | 3/3 | **0/3** |
| hard-log-trace | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| hard-json-migrate | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |

## Files

- ScallopBot: [`scallopbot-v2-checker-r1-3-moonshot-kimi-k2.6.json`](scallopbot-v2-checker-r1-3-moonshot-kimi-k2.6.json) (default), [`scallopbot-v2-review-r1-3-moonshot-kimi-k2.6.json`](scallopbot-v2-review-r1-3-moonshot-kimi-k2.6.json) (read-only review), [`scallopbot-v2-r1-3-moonshot-kimi-k2.6.json`](scallopbot-v2-r1-3-moonshot-kimi-k2.6.json) (no review). These files include full traces (every model call and tool call).
- Prime Agent, OpenClaw, Hermes Agent: `<agent>-v2-r<1..3>-moonshot-kimi-k2.6.json`, one file per repeat, scored with `--cross-agent`.
- Local temp paths are replaced with `<tmp>` and home paths with `~`. No keys or account ids are included.
- Older files in this folder (`*-all.json`, `scallopbot-before-*`, `scallopbot-after-*`, `locomo/`) belong to the earlier 21-task suite and the retired LoCoMo comparison. They are not part of these results.

## Reproduce

```bash
npm run bench:agentic -- --model moonshot:kimi-k2.6 --tasks all --repeat 3 --concurrency 4 --cross-agent
```

Competitor runs: export the tasks, run them with each agent's adapter (COMPARISON-v2.md, "Files"), then score with `--score <run.json> --cross-agent`.
