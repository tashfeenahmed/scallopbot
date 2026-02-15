<p align="center">
  <img src="assets/scallop.png" alt="ScallopBot" width="120" height="120">
</p>

# ScallopBot

<p align="center">
  <strong>A bio-inspired cognitive architecture for personal AI agents.</strong><br>
  <em>Bridging the cognition gap in OpenClaw-compatible agent systems.</em>
</p>

<p align="center">
  <a href="https://github.com/tashfeenahmed/scallopbot/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/tashfeenahmed/scallopbot/ci.yml?branch=main&style=for-the-badge&label=build" alt="CI status"></a>
  <a href="https://github.com/tashfeenahmed/scallopbot/releases"><img src="https://img.shields.io/github/v/release/tashfeenahmed/scallopbot?style=for-the-badge" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=for-the-badge" alt="Node.js"></a>
</p>

<p align="center">
  <a href="pdf/smartbot-research-validation-2col.pdf"><strong>Read the Paper</strong></a>
</p>

---

Open-source personal AI agents like [OpenClaw](https://github.com/openclaw/openclaw) excel at tool orchestration but lack genuine cognitive depth: no memory lifecycle, no self-reflection, no autonomous reasoning. ScallopBot addresses this cognition gap with a bio-inspired cognitive architecture that maintains full compatibility with the OpenClaw skill ecosystem.

ScallopBot runs on your own server, routes each request to the cheapest model that can handle it, tracks every cent in real time, and fails over across 7 LLM providers automatically. It connects to Telegram, Discord, WhatsApp, Slack, Signal, Matrix, a CLI, and a REST/WebSocket API -- all from a single Node.js process.

The architecture is validated against 30 research works from 2023--2026 across six domains (memory retrieval, lifecycle management, associative reasoning, sleep-inspired consolidation, affect modelling, and proactive intelligence). The full cognitive pipeline operates at an estimated **$0.06--0.10 per day**.

## Benchmark Results

Evaluated on the [LoCoMo](https://github.com/snap-research/locomo) long-conversation memory benchmark (1,049 QA items, 5 conversations, 138 sessions):

| Metric | OpenClaw | ScallopBot | Improvement |
|--------|:--------:|:----------:|:-----------:|
| **F1** | 0.39 | **0.51** | +31% |
| **Exact Match** | 0.28 | **0.32** | +14% |

**F1 by question category:**

| Category | OpenClaw | ScallopBot | Delta |
|----------|:--------:|:----------:|:-----:|
| Single-hop | 0.12 | **0.23** | +0.11 |
| Temporal | 0.10 | **0.39** | +0.29 (4x) |
| Open-domain | 0.11 | 0.11 | 0.00 |
| Multi-hop | 0.34 | **0.47** | +0.13 |
| Adversarial | **0.96** | 0.93 | -0.03 |

Temporal questions show a 4x improvement driven by date-embedded memories and temporal query detection. Multi-hop benefits from memory fusion and NREM dream consolidation.

## Cognitive Architecture

ScallopBot's cognitive layer is organised into six subsystems, orchestrated by a three-tier heartbeat daemon:

| Tier | Interval | Operations |
|------|----------|------------|
| **Pulse** | 5 min | Health monitoring, retrieval auditing, affect EMA update |
| **Breath** | 6 h | Decay engine, memory fusion, forgetting |
| **Sleep** | Nightly | Dream cycle (NREM+REM), self-reflection, SOUL re-distillation, gap scanning |

### Bio-Inspired Dream Cycle

A two-phase sleep cycle runs during the nightly heartbeat. **NREM consolidation** clusters and merges fragmented memories across topic boundaries into coherent summaries. **REM exploration** uses high-noise spreading activation to discover non-obvious connections between memories, with an LLM judge evaluating novelty, plausibility, and usefulness of discovered associations.

### Affect-Aware Interaction

Zero-cost emotion detection using AFINN-165 lexicon with VADER-style heuristics, mapped to the Russell circumplex model. A dual-EMA system tracks both session-level mood (2-hour half-life) and baseline mood trends (3-day half-life). An **affect guard** ensures emotional signals inform agent awareness without contaminating instructions.

### Self-Reflection and SOUL Evolution

Nightly composite reflection analyses recent sessions across four dimensions (explanation, principles, procedures, advice). Extracted insights are merged into a living `SOUL.md` personality document, enabling continuous self-improvement through an evolving system prompt -- no model fine-tuning required.

### Proactive Intelligence

A gap scanner identifies unresolved questions, approaching deadlines, and behavioural anomalies. Delivery is gated by a configurable proactiveness dial (conservative/moderate/eager) and a **trust feedback loop** that calibrates future proactive behaviour based on user engagement signals.

### Spreading Activation

ACT-R-inspired spreading activation over typed relation graphs (UPDATES, EXTENDS, DERIVES) with 3-step propagation, fan-out normalisation, and Gaussian noise to prevent deterministic retrieval. The same pure function powers both normal retrieval and REM dream exploration (with elevated noise).

## Key Features

### Hybrid Memory Engine

SQLite-backed memory with ACID guarantees. Combines BM25 keyword scoring with semantic embeddings (Ollama/OpenAI) and optional LLM re-ranking. A complete memory lifecycle includes exponential decay with category-specific half-lives (14 days for events to 346 days for relationships), BFS-clustered fusion, and utility-based forgetting with soft-archive before hard-prune.

### Cost-Aware Model Routing

Every API call is priced at the token level using a built-in pricing database covering 50+ models. A complexity analyzer scores each request and routes it to the cheapest capable tier: fast (Groq, Moonshot), standard (OpenAI, xAI), or capable (Anthropic). Daily and monthly budgets gate requests before they're sent. Provider health is tracked per-call -- consecutive failures trigger automatic failover with exponential backoff and jitter.

### Local-First Voice Pipeline

Speech-to-text via faster-whisper (CTranslate2-optimized Whisper) and text-to-speech via Kokoro (82M param ONNX model) run entirely on-device with zero API cost. Cloud providers (Groq STT, OpenAI TTS) serve as automatic fallbacks. Telegram voice messages are transcribed inline; voice replies are synthesized when enabled.

### Skills-Only Architecture

All capabilities -- bash, browser, file I/O, git, Docker, PDF, web search, memory -- are implemented as self-contained skills using the [OpenClaw](https://github.com/openclaw/openclaw) SKILL.md format. Skills declare their own requirements (binaries, env vars, OS) and are gated at load time. Community skills install from [ClawHub](https://clawhub.ai) with a single CLI command.

## Daily Cost Breakdown

At 100 messages/day with Groq for fast-tier operations:

| Operation | Calls/Day | Daily Cost |
|-----------|:---------:|:----------:|
| Primary conversation | 100 | $0.03 |
| Memory re-ranking | 100 | $0.003 |
| Relation classification | 50 | $0.002 |
| Affect classification | 100 | $0 (lexicon) |
| Decay/fusion (Breath ticks) | 48 | $0.005 |
| Dream cycle (nightly) | 15--20 | $0.005 |
| Self-reflection (nightly) | 2 | $0.002 |
| Gap scanner (nightly) | 3--5 | $0.001 |
| **Total** | | **$0.05--0.10** |

The entire cognitive pipeline -- dreams, reflection, affect, gap scanning -- adds approximately $0.02/day to the base conversation cost.

## Quick Start

```bash
git clone https://github.com/tashfeenahmed/scallopbot.git
cd scallopbot
npm install

cp .env.example .env
# Add at least one LLM provider API key

npm run build
node dist/cli.js start
```

Requires Node.js 22+.

## Providers

| Provider | Default Model | Best For |
|----------|--------------|----------|
| **Anthropic** | Claude Sonnet 4 | Complex reasoning, coding |
| **Moonshot** | Kimi K2.5 (extended thinking) | Cost-effective daily driver |
| **OpenAI** | GPT-4o | General tasks |
| **xAI** | Grok 4 | Real-time information |
| **Groq** | Llama 3.3 70B | Ultra-fast inference |
| **Ollama** | Any local model | Privacy, offline use |
| **OpenRouter** | 100+ models | Maximum flexibility |

Configure one or more in `.env`. The router handles selection and failover automatically.

## Bundled Skills

16 skills ship out of the box:

| Skill | Description |
|-------|-------------|
| `bash` | Execute shell commands |
| `read_file` | Read file contents |
| `write_file` | Create/overwrite files |
| `edit_file` | Make targeted edits |
| `browser` | Web automation ([agent-browser](https://github.com/ArcadeAI/agent-browser) from Vercel Labs) |
| `web_search` | Search via Brave API |
| `memory_search` | Query the hybrid memory engine |
| `reminder` | One-time, interval, and recurring cron reminders |
| `pdf` | Create PDFs with [Typst](https://typst.app), read with poppler, edit with qpdf |
| `git` | Version control operations |
| `npm` | Package management |
| `docker` | Container management |
| `telegram_send` | Send messages programmatically |
| `goals` | Track and manage goals |
| `triggers` | Define event-based triggers |
| `progress` | Report progress to the user |

Install community skills from ClawHub:

```bash
node dist/cli.js skill install elicitation
```

## Channels

| Channel | Features |
|---------|----------|
| **Telegram** | Voice transcription, voice reply, file upload/download, photo analysis, per-user onboarding |
| **Discord** | Slash commands, mention-based chat, DM support |
| **WhatsApp** | Regular account (no Business API needed), QR auth, media support |
| **Slack** | App-based integration |
| **Signal** | End-to-end encrypted messaging |
| **Matrix** | Federated chat |
| **CLI** | Interactive terminal session with session resume (`-s <id>`) |
| **REST API** | `POST /api/chat`, SSE streaming, session management, file download |
| **WebSocket** | Real-time bidirectional communication with the web dashboard |

## Web Dashboard

A React + Tailwind + Vite single-page app served from the API channel. Features:

- Real-time chat with markdown rendering and streaming responses
- Debug mode showing tool execution (start/complete/error), thinking steps, and memory operations
- Cost panel with daily/monthly budget bars, per-model breakdown, and a 14-day spending chart
- File send/receive with download links
- Proactive message delivery (reminders, triggers)

## Configuration

Minimal `.env`:

```bash
ANTHROPIC_API_KEY=sk-...           # At least one provider required
TELEGRAM_BOT_TOKEN=...             # Optional: enable Telegram
TELEGRAM_ALLOWED_USERS=123456789   # Optional: restrict access
BRAVE_SEARCH_API_KEY=...           # Optional: enable web search
```

Budget controls:

```bash
COST_DAILY_BUDGET=5.00
COST_MONTHLY_BUDGET=100.00
COST_WARNING_THRESHOLD=0.8
```

Full reference: [.env.example](.env.example)

## Reminders

Natural language scheduling with timezone awareness:

```
"remind me in 5 minutes to check the build"     -> Interval
"remind me at 10am to take medicine"             -> Absolute time
"remind me every day at 9am to check email"      -> Daily recurring
"remind me every Monday at 3pm about standup"    -> Weekly recurring
"remind me weekdays at 8am to exercise"          -> Weekday recurring
```

Actionable reminders automatically execute when they contain action words (check, search, get, find).

## Error Recovery

| Failure | Response |
|---------|----------|
| Context overflow | Emergency compression -- summarize old messages, keep recent context |
| Auth errors (401/403) | Rotate API keys if multiple are configured |
| Provider outage | Automatic failover to next healthy provider |
| Rate limits | Exponential backoff with jitter |
| Tool crash | RecoveryManager resumes from saved state |
| Process crash | PM2 auto-restart with crash state persistence |

## Architecture

```
+-----------------------------------------------------------------+
|                          SCALLOPBOT                              |
+-----------------------------------------------------------------+
|                                                                  |
|  Telegram ---+                                                   |
|  Discord ----+                                                   |
|  WhatsApp ---+                                                   |
|  Slack ------+-->  GATEWAY --> AGENT --> ROUTER --> PROVIDERS     |
|  Signal -----+       |          |                    |           |
|  Matrix -----+  +---------+    |         +-----------+           |
|  CLI --------+  | Session |    |         | Anthropic |           |
|  API/WS -----+  | Manager |    |         | Moonshot  |           |
|                  +---------+    |         | OpenAI    |           |
|                                 |         | xAI       |           |
|                 +---------------+-+       | Groq      |           |
|                 |  COGNITIVE LAYER |       | Ollama    |           |
|                 |  Pulse | Breath  |       | OpenRouter|           |
|                 |  Sleep | Dreams  |       +-----------+           |
|                 +---------+-------+                               |
|                           |                                       |
|                 +---------+-------+                               |
|                 | Skills | Memory |                               |
|                 | Voice  | Affect |                               |
|                 | Scheduler      |                                |
|                 +----------------+                                |
|                                                                   |
+-------------------------------------------------------------------+
```

## Comparison with OpenClaw

| Capability | OpenClaw | ScallopBot |
|------------|----------|------------|
| **Memory retrieval** | Vector + FTS5 hybrid | BM25 + semantic + LLM re-ranking |
| **Memory decay** | -- | 4-factor exponential with category-specific half-lives |
| **Memory consolidation** | -- | BFS-clustered fusion + NREM cross-category |
| **Memory forgetting** | -- | Utility-based with soft-archive / hard-prune |
| **Associative retrieval** | -- | Spreading activation with typed edges |
| **Dream cycle** | -- | NREM consolidation + REM exploration |
| **Affect detection** | -- | AFINN-165 + VADER + dual-EMA + affect guard |
| **Self-reflection** | -- | Composite reflection + SOUL re-distillation |
| **Proactive intelligence** | Basic Heartbeat | Gap scanner + inner thoughts + trust feedback loop |
| **Background processing** | Heartbeat wake-up | 3-tier daemon (Pulse / Breath / Sleep) |
| **Cost tracking & budgets** | -- | Built-in per-token tracking with daily/monthly limits |
| **Multi-provider routing** | 2 providers | 7 providers with health-aware failover |
| **Smart model selection** | Manual | Auto-routes by complexity |
| **Local voice (zero cost)** | -- | Kokoro TTS + faster-whisper STT |
| **Skill ecosystem** | 100+ bundled, 3000+ ClawHub | Full OpenClaw SKILL.md compatibility |
| **Channel support** | 15+ platforms | 9 channels |
| **Native apps** | macOS/iOS/Android | -- |

## Deployment

### One-Command Server Setup (Ubuntu 24.04)

```bash
git clone https://github.com/tashfeenahmed/scallopbot.git /opt/scallopbot
cd /opt/scallopbot
bash scripts/server-install.sh    # Installs Node 22, PM2, voice deps, Ollama
cp .env.example .env && nano .env
pm2 start ecosystem.config.cjs --env production && pm2 save
```

The install script is idempotent and sets up:

| Component | Purpose |
|-----------|---------|
| Node.js 22 + PM2 | Runtime and process management |
| Python venv (kokoro-onnx, faster-whisper) | Local voice -- zero API cost TTS/STT |
| Ollama + nomic-embed-text | Local embeddings for semantic memory search |
| ffmpeg + sox | Audio format conversion |

### Alternative: Docker

```bash
docker build -t scallopbot .
docker run -d --env-file .env scallopbot
```

### Alternative: systemd

```bash
sudo tee /etc/systemd/system/scallopbot.service << EOF
[Unit]
Description=ScallopBot AI Assistant
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/scallopbot
ExecStart=/usr/bin/node /opt/scallopbot/dist/cli.js start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now scallopbot
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `start` | Launch gateway with all configured channels |
| `chat` | Interactive CLI session (`-s <id>` to resume) |
| `config` | Show current configuration (`--json` for machine output) |
| `version` | Show version |
| `skill search <query>` | Search ClawHub |
| `skill install <slug>` | Install from ClawHub |
| `skill uninstall <name>` | Remove a skill |
| `skill list` | List installed skills |
| `skill update [name]` | Update one or all skills |
| `migrate run` | Migrate legacy JSONL memories to SQLite |

## Project Structure

```
src/
├── agent/          # Agent loop, session management, crash recovery
├── channels/       # Telegram, Discord, WhatsApp, Slack, Signal, Matrix, CLI, API
├── config/         # Zod-validated configuration schemas
├── dashboard/      # Systemd config generator, crash recovery
├── gateway/        # Server orchestration and channel initialization
├── media/          # PDF, image, URL processing
├── memory/         # Hybrid search, fact extraction, decay engine, profiles
├── proactive/      # Unified scheduler for reminders and triggers
├── providers/      # LLM provider implementations (7 providers)
├── reliability/    # Circuit breaker, graceful degradation
├── routing/        # Cost tracking, complexity analysis, model selection
├── skills/         # Loader, registry, executor, ClawHub client (16 bundled)
├── voice/          # STT (faster-whisper/Groq/OpenAI), TTS (Kokoro/OpenAI)
├── cli.ts          # CLI entry point
└── index.ts        # Library exports

web/                # React + Tailwind + Vite dashboard
```

## Development

```bash
npm run dev           # Dev mode with hot reload
npm test              # Run tests (Vitest)
npm run typecheck     # Type check
npm run build         # Production build (compiles TS + builds web dashboard)
```

## Research Validation

ScallopBot's design decisions independently converged on patterns validated by 30 research works from 2023--2026, published at venues including ICLR, NeurIPS, CHI, and ACM TOIS. Key alignments include:

- **Hybrid retrieval**: Hu et al. (memory survey), Pan et al. (SeCom, ICLR 2025)
- **Memory lifecycle**: Alqithami (MaRS forgetting benchmark), Yang et al. (graph memory taxonomy)
- **Spreading activation**: Pavlovic et al. (activation in RAG), Yang et al. (relational dependencies)
- **Dream cycles**: Zhang (computational account of dreaming)
- **Affect modelling**: Mozikov et al. (emotional prompting effects), Lu & Li (affective memory)
- **Self-reflection**: Shinn et al. (Reflexion, 91% HumanEval), Renze & Guven (reflection taxonomy)
- **Proactive intelligence**: Pasternak et al. (PROBE), Liu et al. (Inner Thoughts)

For the full analysis, see [the paper](pdf/smartbot-research-validation-2col.pdf).

## License

MIT

---

<p align="center">
  Built by <a href="https://github.com/tashfeenahmed">@tashfeenahmed</a>
</p>
