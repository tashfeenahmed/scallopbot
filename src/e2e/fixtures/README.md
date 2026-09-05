# charlie-turns.json

Scrubbed replay of the production "Charlie" Telegram bot (pm2 `tashbot`),
13 Jul – 2 Sep 2026, used by `src/e2e/charlie-replay.test.ts`.

One JSON object per line, each a user turn:

| field | meaning |
| --- | --- |
| `turn` | index in the original 76-turn extraction (bare greetings with no tool calls were dropped) |
| `ts` | Dublin wall-clock time, minute precision, no zone suffix (all turns are in Irish Summer Time, UTC+1) |
| `user` | the user's message exactly as received (Telegram reply wrappers included) |
| `previousAssistantMessage` | the assistant reply the user was responding to |
| `toolCalls[]` | `{name, input, result:{is_error, code?, excerpt?}}` in call order |
| `final` | the assistant's final reply; kept only for promise-only turns, blocked turns and the 14 Jul "Yes!" turn |
| `blockedCount` | calls rejected with `SAFETY_EXTERNAL_INTENT_REQUIRED` / `SAFETY_LOCAL_INTENT_REQUIRED` |
| `mutationSucceeded` | at least one verified Notion write completed in this turn |
| `promiseNoTool` | the final reply promised a write ("I'll add these to Notion now") with zero tool calls |

Scrubbing applied when the file was built:

- tool-result excerpts truncated to 120 characters and kept only for `notion`
  calls and failed calls; excerpts containing a Notion token or `[REDACTED]`
  were removed entirely;
- literal `ntn_…` tokens inside bash inputs replaced with `ntn_REDACTED`;
- long `command` / `code` / `content` inputs of non-Notion tools cut at 240 characters;
- `systemNudges` dropped.

Gym data and the (anonymised, consistently remapped) Notion ids (`1801c5f6-…`, data source `7c048c39-…`)
and the user's first name are intentionally kept: the tests assert on them.
