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

## Why ScallopBot?

Both ScallopBot and [OpenClaw](https://github.com/openclaw/openclaw) are self-hosted AI assistants. Here's how they differ:

| Feature | ScallopBot | OpenClaw |
|---------|:----------:|:--------:|
| **Cost tracking & budgets** | ✅ Built-in | ❌ |
| **Multi-provider routing** | ✅ 7 providers | ✅ 2 providers |
| **Smart model selection** | ✅ Auto-routes by task | ❌ Manual |
| **Setup complexity** | Simple (just Node.js) | Complex (daemon + apps) |
| **Channels** | Telegram, CLI | 12+ channels |
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
- **🧠 Persistent Memory** — Semantic search + automatic fact extraction
- **🔄 Provider Fallback** — Automatically switches providers on failures
- **🗣️ Voice Support** — Speech-to-text input, text-to-speech responses
- **⏰ Smart Reminders** — Intervals, absolute times, and recurring schedules
- **📁 File Operations** — Send and receive files via chat
- **🌐 Browser Automation** — Navigate, scrape, and interact with websites
- **🔧 Extensible Skills** — OpenClaw-compatible SKILL.md format

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
# At least one provider required
MOONSHOT_API_KEY=sk-...          # Recommended: cost-effective default

# Telegram bot
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USERS=123456789

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

## Tools

| Tool | Category | Description |
|------|----------|-------------|
| `read` | Coding | Read file contents |
| `write` | Coding | Create/overwrite files |
| `edit` | Coding | Make targeted edits |
| `bash` | System | Execute shell commands |
| `browser` | Web | Navigate and scrape websites |
| `web_search` | Search | Search the web (Brave API) |
| `memory_search` | Memory | Search conversation history |
| `voice_reply` | Comms | Send voice messages |
| `reminder` | Automation | Set one-time or recurring reminders |
| `send_file` | Comms | Send files to user |

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

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         SCALLOPBOT                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│    Telegram ──┐                                                  │
│               ├──▶ GATEWAY ──▶ AGENT ──▶ PROVIDERS              │
│    CLI ───────┘         │         │         │                    │
│                         │         │         ├─▶ Anthropic        │
│                    ┌────┴────┐    │         ├─▶ Moonshot         │
│                    │ Session │    │         ├─▶ OpenAI           │
│                    │ Manager │    │         ├─▶ xAI              │
│                    └─────────┘    │         ├─▶ Groq             │
│                                   │         └─▶ Ollama           │
│                              ┌────┴────┐                         │
│                              │  Tools  │                         │
│                              │ Memory  │                         │
│                              │ Skills  │                         │
│                              └─────────┘                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `start` | Start gateway with Telegram |
| `chat` | Interactive CLI session |
| `config` | Show current configuration |
| `skill search <query>` | Search skill registry |
| `skill install <name>` | Install a skill |
| `skill list` | List installed skills |

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome + onboarding |
| `/help` | Show all commands |
| `/settings` | View configuration |
| `/setup` | Reconfigure bot name/personality |
| `/new` | Start fresh conversation |

## Deployment

### Systemd Service

```bash
# Copy to server
rsync -avz --exclude node_modules ./ user@server:/opt/scallopbot/

# On server
cd /opt/scallopbot
npm install
npm run build

# Create service
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

# Enable and start
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

ScallopBot automatically:
- **Extracts facts** from conversations (names, preferences, relationships)
- **Deduplicates** similar memories to prevent bloat
- **Prunes** old, low-relevance memories
- **Searches** using hybrid semantic + keyword matching

Memory is persisted to disk and survives restarts.

## Error Recovery

When things go wrong, ScallopBot handles it gracefully:

1. **Context overflow** → Emergency compression (keeps recent context)
2. **Auth errors (401/403)** → Rotate API keys if available
3. **Provider errors** → Automatic fallback to next provider
4. **Rate limits** → Exponential backoff with jitter

## Project Structure

```
src/
├── agent/          # Agent loop, session management
├── channels/       # Telegram, CLI channels
├── config/         # Configuration schemas
├── gateway/        # Server orchestration
├── media/          # PDF, image, URL processing
├── memory/         # Semantic search, fact extraction
├── providers/      # LLM provider implementations
├── reliability/    # Circuit breaker, degradation
├── routing/        # Cost tracking, model selection
├── skills/         # Skill loading, registry
├── tools/          # Tool implementations
├── voice/          # STT/TTS support
└── cli.ts          # CLI entry point
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
