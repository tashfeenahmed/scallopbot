<p align="center">
  <img src="assets/scallop.png" alt="ScallopBot" width="120" height="120">
</p>

# ScallopBot

<p align="center">
  <strong>Self-hosted AI assistant with intelligent cost optimization, persistent memory, and multi-channel deployment.</strong>
</p>

<p align="center">
  <a href="https://github.com/tashfeenahmed/scallopbot/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/tashfeenahmed/scallopbot/ci.yml?branch=main&style=for-the-badge&label=build" alt="CI status"></a>
  <a href="https://github.com/tashfeenahmed/scallopbot/releases"><img src="https://img.shields.io/github/v/release/tashfeenahmed/scallopbot?style=for-the-badge" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=for-the-badge" alt="Node.js"></a>
</p>

---

ScallopBot runs on your own server, routes each request to the cheapest model that can handle it, tracks every cent in real time, and fails over across 7 LLM providers automatically. It connects to Telegram, Discord, WhatsApp, Slack, Signal, Matrix, a CLI, and a REST/WebSocket API — all from a single Node.js process.

## Key Innovations

### Hybrid Memory Engine

SQLite-backed memory with ACID guarantees. Combines BM25 keyword scoring with semantic embeddings (Ollama/OpenAI) and a relationship graph (UPDATES, EXTENDS, DERIVES). A decay engine progressively fades stale memories while a fact extractor automatically captures names, preferences, and relationships from conversations. User profiles, session summaries, and temporal grounding (understands "next Tuesday" in context) are all built in.

### Cost-Aware Model Routing

Every API call is priced at the token level using a built-in pricing database covering 50+ models. A complexity analyzer scores each request and routes it to the cheapest capable tier: fast (Groq, Moonshot), standard (OpenAI, xAI), or capable (Anthropic). Daily and monthly budgets gate requests before they're sent. Provider health is tracked per-call — consecutive failures trigger automatic failover with exponential backoff and jitter.

### Local-First Voice Pipeline

Speech-to-text via faster-whisper (CTranslate2-optimized Whisper) and text-to-speech via Kokoro (82M param ONNX model) run entirely on-device with zero API cost. Cloud providers (Groq STT, OpenAI TTS) serve as automatic fallbacks. Telegram voice messages are transcribed inline; voice replies are synthesized when enabled.

### Proactive Scheduling with Double-Write Prevention

A unified cron scheduler handles user reminders, agent-triggered messages, and webhook callbacks. Atomic claim guards prevent duplicate execution across restarts. Reminders with action words ("check the build", "search for updates") execute the action autonomously when they fire, not just notify.

### Skills-Only Architecture

All capabilities — bash, browser, file I/O, git, Docker, PDF, web search, memory — are implemented as self-contained skills using the [OpenClaw](https://github.com/openclaw/openclaw) SKILL.md format. Skills declare their own requirements (binaries, env vars, OS) and are gated at load time. Community skills install from [ClawHub](https://clawhub.ai) with a single CLI command.

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
"remind me in 5 minutes to check the build"     → Interval
"remind me at 10am to take medicine"             → Absolute time
"remind me every day at 9am to check email"      → Daily recurring
"remind me every Monday at 3pm about standup"    → Weekly recurring
"remind me weekdays at 8am to exercise"          → Weekday recurring
```

Actionable reminders automatically execute when they contain action words (check, search, get, find).

## Error Recovery

| Failure | Response |
|---------|----------|
| Context overflow | Emergency compression — summarize old messages, keep recent context |
| Auth errors (401/403) | Rotate API keys if multiple are configured |
| Provider outage | Automatic failover to next healthy provider |
| Rate limits | Exponential backoff with jitter |
| Tool crash | RecoveryManager resumes from saved state |
| Process crash | PM2 auto-restart with crash state persistence |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          SCALLOPBOT                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Telegram ───┐                                                  │
│  Discord ────┤                                                  │
│  WhatsApp ───┤                                                  │
│  Slack ──────┼──▶ GATEWAY ──▶ AGENT ──▶ ROUTER ──▶ PROVIDERS   │
│  Signal ─────┤       │         │                    │           │
│  Matrix ─────┤  ┌────┴────┐    │         ┌──────────┤           │
│  CLI ────────┤  │ Session │    │         │ Anthropic│           │
│  API/WS ─────┘  │ Manager │    │         │ Moonshot │           │
│                  └─────────┘    │         │ OpenAI   │           │
│                                 │         │ xAI      │           │
│                            ┌────┴────┐    │ Groq     │           │
│                            │ Skills  │    │ Ollama   │           │
│                            │ Memory  │    │ OpenRouter│          │
│                            │ Voice   │    └──────────┘           │
│                            │ Scheduler│                          │
│                            └─────────┘                           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

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
| Python venv (kokoro-onnx, faster-whisper) | Local voice — zero API cost TTS/STT |
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

## Comparison with OpenClaw

| Feature | ScallopBot | OpenClaw |
|---------|:----------:|:--------:|
| Cost tracking & budgets | Built-in | -- |
| Multi-provider routing | 7 providers with failover | 2 providers |
| Smart model selection | Auto-routes by complexity | Manual |
| Memory system | Hybrid BM25 + semantic + relations | Semantic |
| Setup | Single Node.js process | Daemon + apps |
| Channels | 8 | 12+ |
| Native apps | -- | macOS/iOS/Android |
| Voice Wake | -- | Supported |
| Skills | 16 bundled, OpenClaw-compatible | Supported |
| PDF generation | Typst | -- |
| Local voice (zero cost) | Kokoro TTS + faster-whisper STT | -- |

## License

MIT

---

<p align="center">
  Built by <a href="https://github.com/tashfeenahmed">@tashfeenahmed</a>
</p>
