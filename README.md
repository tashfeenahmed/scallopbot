<p align="center">
  <img src="assets/scallop.png" alt="ScallopBot" width="120" height="120">
</p>

# 🐚 ScallopBot — Cost-Optimized Personal AI

<p align="center">
  <strong>Your AI. Your Server. Your Budget.</strong>
</p>

<p align="center">
  <a href="https://github.com/tashfeenahmed/scallopbot/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/tashfeenahmed/scallopbot/ci.yml?branch=main&style=for-the-badge&label=build" alt="CI status"></a>
  <a href="https://github.com/tashfeenahmed/scallopbot/releases"><img src="https://img.shields.io/github/v/release/tashfeenahmed/scallopbot?style=for-the-badge" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=for-the-badge" alt="Node.js"></a>
</p>

---

**ScallopBot** is a self-hosted AI assistant that runs on your VPS with **intelligent cost optimization**. It automatically routes requests to the cheapest capable model, tracks your spending in real-time, and falls back gracefully when providers fail.

Unlike cloud-hosted assistants, ScallopBot gives you:
- **Full system access** — bash, file operations, browser automation
- **Persistent memory** — remembers your preferences, facts, and context
- **Multi-provider routing** — uses the right model for each task
- **Budget controls** — daily/monthly limits with automatic throttling
- **8 chat channels** — Telegram, Discord, WhatsApp, Slack, Signal, Matrix, CLI, REST API

## Why ScallopBot?

Both ScallopBot and [OpenClaw](https://github.com/openclaw/openclaw) are self-hosted AI assistants. Here's how they differ:

| Feature | ScallopBot | OpenClaw |
|---------|:----------:|:--------:|
| **Cost tracking & budgets** | ✅ Built-in | ❌ |
| **Multi-provider routing** | ✅ 7 providers | ✅ 2 providers |
| **Smart model selection** | ✅ Auto-routes by task | ❌ Manual |
| **Setup complexity** | Simple (just Node.js) | Complex (daemon + apps) |
| **Channels** | 8 (Telegram, Discord, WhatsApp, Slack, Signal, Matrix, CLI, API) | 12+ channels |
| **Native apps** | ❌ | ✅ macOS/iOS/Android |
| **Voice Wake** | ❌ | ✅ |
| **Canvas/Visual workspace** | ❌ | ✅ |
| **Persistent memory** | ✅ Semantic + facts | ✅ |
| **Skills system** | ✅ OpenClaw-compatible | ✅ |
| **File send/receive** | ✅ | ✅ |
| **Recurring reminders** | ✅ | ✅ Cron |
| **Browser automation** | ✅ | ✅ |

**TL;DR:**
- Choose **ScallopBot** if you want **cost control**, **multi-provider flexibility**, and **simple deployment**
- Choose **OpenClaw** if you need **many channels**, **native apps**, and **Voice Wake**

## Highlights

- **🎯 Smart Model Routing** — Routes simple queries to cheap models, complex tasks to capable ones
- **💰 Real-time Cost Tracking** — Daily/monthly budgets with automatic throttling
- **🧠 Persistent Memory** — SQLite-backed semantic search + automatic fact extraction
- **🔄 Provider Fallback** — Automatically switches providers on failures
- **💬 8 Chat Channels** — Telegram, Discord, WhatsApp, Slack, Signal, Matrix, CLI, REST API
- **🗣️ Voice Support** — Speech-to-text input, text-to-speech responses
- **⏰ Smart Reminders** — Intervals, absolute times, and recurring schedules
- **📁 File Operations** — Send and receive files via chat
- **🌐 Browser Automation** — Navigate, scrape, and interact with websites
- **🔧 Extensible Skills** — OpenClaw-compatible SKILL.md format
- **📄 Media Processing** — PDF extraction, image analysis, link previews

## Supported Providers

| Provider | Models | Best For |
|----------|--------|----------|
| **Anthropic** | Claude Opus 4.5, Sonnet 4 | Complex reasoning, coding |
| **Moonshot** | Kimi K2.5 | Cost-effective daily driver |
| **OpenAI** | GPT-4o, GPT-4 Turbo | General tasks |
| **xAI** | Grok 2, Grok 3 | Real-time information |
| **Groq** | Llama 3.3 70B | Ultra-fast responses |
| **Ollama** | Any local model | Privacy, offline use |
| **OpenRouter** | 100+ models | Maximum flexibility |

## Quick Start

**Runtime:** Node.js ≥22

```bash
# Clone and install
git clone https://github.com/tashfeenahmed/scallopbot.git
cd scallopbot
npm install

# Configure
cp .env.example .env
# Edit .env with your API keys

# Build and run
npm run build
node dist/cli.js start
```

## Configuration

Minimal `.env`:

```bash
# At least one LLM provider required
MOONSHOT_API_KEY=sk-...          # Recommended: cost-effective default

# Telegram bot (optional)
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USERS=123456789

# Discord bot (optional)
DISCORD_BOT_TOKEN=...

# Optional but recommended
BRAVE_SEARCH_API_KEY=...         # Enables web search
```

Full configuration reference: [.env.example](.env.example)

## Cost Optimization

ScallopBot includes built-in cost controls:

```typescript
// In your .env or config
COST_DAILY_BUDGET=5.00           # $5/day limit
COST_MONTHLY_BUDGET=100.00       # $100/month limit
COST_WARNING_THRESHOLD=0.8       # Warn at 80% usage
```

**How it works:**
1. Every API call is tracked with token counts and model pricing
2. Budget usage is calculated in real-time
3. When approaching limits, the system warns you
4. At budget limit, requests are blocked (not charged)
5. Provider fallback prefers cheaper alternatives

## Bundled Skills

ScallopBot uses a skills-only architecture with 12 bundled skills:

| Skill | Category | Description |
|-------|----------|-------------|
| `bash` | System | Execute shell commands |
| `read_file` | Coding | Read file contents |
| `write_file` | Coding | Create/overwrite files |
| `edit_file` | Coding | Make targeted edits |
| `browser` | Web | Navigate and scrape websites |
| `web_search` | Search | Search the web (Brave API) |
| `memory_search` | Memory | Search conversation history and memories |
| `reminder` | Automation | Set one-time or recurring reminders |
| `telegram_send` | Comms | Send Telegram messages programmatically |
| `git` | DevOps | Git version control operations |
| `npm` | DevOps | Node package manager commands |
| `docker` | DevOps | Docker container management |

## Reminders

ScallopBot supports flexible reminder scheduling:

```
"remind me in 5 minutes to check the build"     → Interval
"remind me at 10am to take medicine"            → Absolute time
"remind me every day at 9am to check email"     → Daily recurring
"remind me every Monday at 3pm about standup"   → Weekly recurring
"remind me weekdays at 8am to exercise"         → Weekday recurring
```

**Actionable reminders** — If the reminder contains an action word (check, get, search, find), ScallopBot will **execute the action** when it triggers, not just remind you.

## Skills (OpenClaw Compatible)

ScallopBot uses the OpenClaw SKILL.md format:

```markdown
---
name: git
description: Git version control operations
user-invocable: true
metadata:
  openclaw:
    emoji: "🔀"
    requires:
      bins: [git]
---

# Git Skill

Help with git operations: status, commit, push, pull, branch management...
```

**Skill loading priority:**
1. User skills (`~/.scallopbot/skills/`)
2. Project skills (`./.scallopbot/skills/`)
3. Bundled skills (built-in)

## Installing Skills from ClawHub

[ClawHub](https://clawhub.ai) is the community skill registry. Browse available skills at https://clawhub.ai/skills

### Search for skills

```bash
node dist/cli.js skill search git
```

### View skill details

```bash
node dist/cli.js skill hub elicitation
```

### Install a skill

```bash
# Install by slug (from ClawHub URL: clawhub.ai/username/skill-name → use skill-name)
node dist/cli.js skill install elicitation

# Install specific version
node dist/cli.js skill install elicitation -v 1.0.0
```

### After installing

Restart the bot to load new skills:

```bash
# If running with PM2
pm2 restart scallopbot

# If running directly
# Stop and restart: node dist/cli.js start
```

### Manage installed skills

```bash
# List all installed skills
node dist/cli.js skill list

# Show skill details
node dist/cli.js skill info elicitation

# Uninstall a skill
node dist/cli.js skill uninstall elicitation

# Update skills
node dist/cli.js skill update           # Update all
node dist/cli.js skill update elicitation  # Update specific
```

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                            SCALLOPBOT                                │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Telegram ───┐                                                       │
│  Discord ────┤                                                       │
│  WhatsApp ───┤                                                       │
│  Slack ──────┼──▶ GATEWAY ──▶ AGENT ──▶ ROUTER ──▶ PROVIDERS        │
│  Signal ─────┤        │         │                    │               │
│  Matrix ─────┤   ┌────┴────┐    │         ┌──────────┤               │
│  CLI ────────┤   │ Session │    │         │ Anthropic│               │
│  API ────────┘   │ Manager │    │         │ Moonshot │               │
│                  └─────────┘    │         │ OpenAI   │               │
│                                 │         │ xAI      │               │
│                            ┌────┴────┐    │ Groq     │               │
│                            │ Skills  │    │ Ollama   │               │
│                            │ Memory  │    │ OpenRouter               │
│                            │ Voice   │    └──────────┘               │
│                            │         │                               │
│                            └─────────┘                               │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `start` | Start gateway with all configured channels |
| `chat` | Interactive CLI session (supports `-s <id>` to resume) |
| `config` | Show current configuration (`--json` for JSON output) |
| `version` | Show version information |
| `skill search <query>` | Search ClawHub for skills |
| `skill install <slug>` | Install a skill from ClawHub |
| `skill uninstall <name>` | Uninstall a skill |
| `skill list` | List installed skills (`--available` for all) |
| `skill update [name]` | Update one or all skills |
| `skill hub <slug>` | Get skill info from ClawHub |
| `skill versions <slug>` | List available versions |
| `skill info <name>` | Show details of an installed skill |
| `migrate run` | Migrate JSONL memories to SQLite |
| `migrate verify` | Verify migration integrity |
| `migrate rollback` | Remove SQLite database (requires `--force`) |

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome + onboarding |
| `/help` | Show all commands |
| `/stop` | Stop current task |
| `/settings` | View configuration |
| `/setup` | Reconfigure bot name/personality |
| `/new` | Start fresh conversation |

Telegram also supports voice messages (auto-transcribed), document/file uploads, and photo analysis.

## Discord Commands

| Command | Description |
|---------|-------------|
| `/ask <message>` | Ask ScallopBot a question |
| `/reset` | Clear conversation history |
| `/help` | Show help information |
| `/status` | Show current session status |

Discord also supports direct message replies and mention-based chat in channels.

## Deployment

### Server Install Script (Recommended)

The install script sets up everything on a fresh Ubuntu 24.04 server — Node.js 22, PM2, Python voice packages (Kokoro TTS + faster-whisper STT), Ollama embeddings, ffmpeg, and sox:

```bash
# Clone to server
git clone https://github.com/tashfeenahmed/scallopbot.git /opt/scallopbot
cd /opt/scallopbot

# Run the install script (installs all system + app dependencies)
bash scripts/server-install.sh

# Configure
cp .env.example .env
# Edit .env with your API keys

# Start
pm2 start ecosystem.config.cjs --env production
pm2 save
```

The script is idempotent — safe to run multiple times. It installs:

| Component | What | Why |
|-----------|------|-----|
| **Node.js 22** | Runtime | Required |
| **PM2** | Process manager | Auto-restart, logging, boot persistence |
| **Python venv** | `~/.scallopbot/venv/` | Voice support (TTS + STT) |
| **kokoro-onnx** | Local TTS | Free text-to-speech (10 voices) |
| **faster-whisper** | Local STT | Free speech-to-text (CTranslate2 optimized) |
| **Kokoro models** | `~/.cache/kokoro/` | 82M param ONNX model + voice embeddings |
| **Ollama** | Local embedding server | Semantic memory search |
| **nomic-embed-text** | Embedding model (274MB) | Vector embeddings for memory |
| **ffmpeg / sox** | Audio tools | Voice format conversion |

### PM2

```bash
# Start with PM2 (uses ecosystem.config.cjs)
npx pm2 start ecosystem.config.cjs --env production
npx pm2 save
npx pm2 startup  # Enable auto-start on boot
```

**Important:** Always use `dist/cli.js start`, not `dist/index.js`. The ecosystem config handles this automatically.

### Systemd Service

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

sudo systemctl enable scallopbot
sudo systemctl start scallopbot
```

### Docker

```bash
docker build -t scallopbot .
docker run -d --env-file .env scallopbot
```

## Development

```bash
npm test              # Run tests
npm run dev           # Dev mode with hot reload
npm run typecheck     # Type check only
npm run build         # Production build
```

## Memory System

ScallopBot uses a **SQLite-backed memory store** with WAL mode for concurrent access:

- **Extracts facts** from conversations (names, preferences, relationships)
- **Hybrid search** — combines semantic (embedding-based) and keyword (BM25) matching
- **Memory relations** — tracks UPDATES, EXTENDS, and DERIVES relationships between memories
- **Decay engine** — progressively diminishes importance of old memories
- **Profile tracking** — maintains user/entity profiles (name, role, relationships)
- **Temporal grounding** — event dates and document dates for time-aware queries
- **Categories** — raw, fact, summary, preference, and context memory types

Memory is persisted to disk and survives restarts. Legacy JSONL stores can be migrated to SQLite via `migrate run`.

## Error Recovery

When things go wrong, ScallopBot handles it gracefully:

1. **Context overflow** → Emergency compression (keeps recent context)
2. **Auth errors (401/403)** → Rotate API keys if available
3. **Provider errors** → Automatic fallback to next provider
4. **Rate limits** → Exponential backoff with jitter

## Project Structure

```
src/
├── agent/          # Agent loop, session management, recovery
├── branching/      # Branching logic
├── cache/          # Caching layer
├── channels/       # Telegram, Discord, WhatsApp, Slack, Signal, Matrix, CLI, API
├── config/         # Configuration schemas (Zod-validated)
├── dashboard/      # Web dashboard
├── gateway/        # Server orchestration and initialization
├── media/          # PDF, image, URL processing
├── memory/         # SQLite-backed semantic search, fact extraction, decay
├── providers/      # LLM provider implementations (7 providers)
├── reliability/    # Circuit breaker, graceful degradation
├── routing/        # Cost tracking, complexity analysis, model selection
├── scheduler/      # Task scheduling
├── skills/         # Skill loading, registry, ClawHub integration (12 bundled skills)
├── tailscale/      # Tailscale VPN integration
├── triggers/       # Event trigger system
├── utils/          # Utilities and helpers
├── voice/          # STT/TTS support
├── cli.ts          # CLI entry point
└── index.ts        # Library exports
```

## Contributing

PRs welcome! Please:
1. Run `npm test` before submitting
2. Follow existing code style
3. Add tests for new features

## License

MIT — use it however you want.

---

<p align="center">
  Built with 🐚 by <a href="https://github.com/tashfeenahmed">@tashfeenahmed</a>
</p>
