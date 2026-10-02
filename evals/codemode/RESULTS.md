# Code-mode A/B results

## Run 2026-10-02: tool vs code vs hybrid

- **Command:** `BENCH_MODES=tool,code,hybrid BENCH_TRIALS=3 npm run bench:codemode`
- **Model:** Moonshot `kimi-k2.6`, thinking off. It is the weakest model this key can reach; `kimi-k2.5` now returns 404. The key also lists `kimi-k3`, `kimi-k2.7-code` and `kimi-k2.7-code-highspeed`. `OPENROUTER_API_KEY` is not set, so there was no Qwen run.
- **Setup:** real `Agent` loop with `subAgentMode` (minimal prompt) and real bundled script tools.
  - **tool:** `read_file`, `write_file`, `edit_file`, `grep`, `glob`, `bash` and `ls`.
  - **code:** only `exec`, plus `buildCodeModePrompt()`.
  - **hybrid:** the tool-mode tools plus `execute_code`.
- **Scoring:** from the filesystem after the turn (exact CSV / names / `node test.js`).

### Totals (4 tasks × 3 trials per mode)

| mode | pass | LLM calls | input tokens | output tokens | wall seconds |
|---|---|---|---|---|---|
| tool | 11/12 | 69 | 270,581 | 8,581 | 195 |
| code | **12/12** | **45** (−35%) | **119,074** (−56%) | 10,145 (+18%) | 205 |
| hybrid | 12/12 | 47 (−32%) | 192,530 (−29%) | 10,417 | 203 |

### Per task (mean of 3 trials)

| task | mode | pass | LLM calls | input tok |
|---|---|---|---|---|
| todo-csv (40 files → CSV) | tool | 3/3 | 5.7 | 18,849 |
| | code | 3/3 | 3.3 | 8,386 |
| | hybrid | 3/3 | 2.7 | 10,106 |
| largest-functions (12 files) | tool | 3/3 | 3.7 | 9,544 |
| | code | 3/3 | 2.7 | 7,463 |
| | hybrid | 3/3 | 3.0 | 11,779 |
| rename-and-test (5 files + `node test.js`) | tool | 3/3 | 5.3 | 17,241 |
| | code | 3/3 | 6.3 | 16,909 |
| | hybrid | 3/3 | 5.0 | 20,054 |
| unused-exports (30 modules, long-context) | tool | **2/3** | 8.3 | 44,559 |
| | code | 3/3 | **2.7** | **6,934** |
| | hybrid | 3/3 | 5.0 | 22,237 |

The one failure was tool trial 1 on unused-exports. The model listed about 40 names that are actually imported, because it matched names textually instead of parsing the imports.

### What the numbers say

- **Biggest gain on the many-files task (unused-exports).** Code mode used 3× fewer LLM calls and 6× fewer input tokens, with no failures. Tool mode's input grows with every file it reads into the context, and one trial reached 13 calls and 73k tokens.
- **Even on easy tasks, code mode was never worse on pass rate.** It used fewer input tokens on every task. rename-and-test was the exception on LLM calls: about the same, because the model runs and re-checks the tests in separate cells.
- **Output tokens are 18% higher in code mode.** The model writes programs instead of JSON arguments, but input dominates cost: 119k vs 271k tokens.
- **Wall time was about the same.** Code cells spent their time in script-tool subprocesses (each bundled tool spawns `tsx`). Faster native tools, which are being built in parallel, should help code mode most.
- **Hybrid sits in the middle.** It is a safe fallback for models that misuse the kernel: same pass rate, fewer calls than tool mode, but about 60% more input tokens than code mode.
- **The "inner tool calls" column is often 0 in code mode.** Kimi often skipped the API and used Node's `fs` directly, joining paths with `WORKSPACE`. That works, but it bypasses tool-level guards such as path validation and redaction. If that matters, the prompt should say "prefer the API over fs".

### Caveats

- Only 3 trials per cell, on one model, with small seeded tasks.
- The bench uses the minimal sub-agent prompt, not the full ScallopBot prompt with memory and persona.
- The cache-hit columns weren't analysed.
- These are directional numbers, not a verdict. Re-run after the native tool rewrite with `BENCH_TRIALS=5` and, once a key is available, `BENCH_PROVIDER=openrouter` for Qwen.

## Pilot run, same day (1 trial, 3 tasks, tool vs code)

Both modes passed 3/3. Totals: tool used 17 LLM calls and 147k input tokens; code used 14 calls and 41k input tokens.

This pilot surfaced three harness or kernel bugs, all fixed before the run above:

- **Deployment env leaked into the bench.** `.env` sets `AGENT_WORKSPACE` to a deployment path, which broke the bash tool's cwd. The bench now unsets it.
- **Ambiguous rename task.** It also asked the model to rename the assertion in `test.js`.
- **Handle id not set at creation.** `h.id` was `undefined` right after `bash()`. Handle ids are now assigned in the kernel, synchronously.

An earlier, ambiguous run also showed what a weak model does in the kernel. It went around the broken `bash` with `child_process`, then waited on an event that had already fired, which hit the 300-second cell timeout. The kernel interrupted the cell, kept the variables, and the turn recovered.
