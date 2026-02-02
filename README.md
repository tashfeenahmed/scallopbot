# ScallopBot

A personal AI assistant that runs on your VPS, accessible via Telegram, with full system access and persistent sessions.

## Features

- **Telegram Integration**: Chat with your bot from anywhere
- **Interactive Onboarding**: Set up bot name, personality, and model on first use
- **Multi-Provider Support**: Claude, GPT-4o, Kimi K2.5, Grok, Llama via Groq
- **Admin Whitelist**: Restrict bot access to specific Telegram user IDs
- **Full VPS Access**: Read/write files, execute commands, no sandbox restrictions
- **Session Persistence**: Conversations survive restarts (JSONL storage)
- **Core Tools**: Read, Write, Edit, Bash - everything you need
- **Token Tracking**: Monitor usage per session
- **Graceful Shutdown**: Proper SIGTERM/SIGINT handling

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/tashfeenahmed/scallopbot.git
cd scallopbot
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-your-key-here

# Optional - enables Telegram bot
TELEGRAM_BOT_TOKEN=your-telegram-bot-token

# Optional - defaults to current directory
AGENT_WORKSPACE=/path/to/workspace
```

### 3. Build and Run

```bash
# Build
npm run build

# Start the gateway (with Telegram)
node dist/cli.js start

# Or interactive CLI chat (no Telegram needed)
node dist/cli.js chat
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `scallopbot start` | Start gateway server with Telegram |
| `scallopbot chat` | Interactive CLI chat session |
| `scallopbot config` | Show current configuration |
| `scallopbot version` | Show version |

### Start Options

```bash
# Verbose logging
scallopbot start --verbose

# Resume existing chat session
scallopbot chat --session <session-id>
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message (triggers onboarding for new users) |
| `/help` | Show all available commands |
| `/settings` | View your bot configuration |
| `/setup` | Reconfigure bot (name, personality, model) |
| `/reset` | Clear conversation history |

### First-Time Setup

When you first message the bot, it will guide you through setup:
1. **Name**: Choose what to call your bot (Jarvis, Friday, etc.)
2. **Personality**: Professional, Friendly, Technical, Creative, or Custom
3. **Model**: Claude Sonnet (default), Claude Opus, Kimi K2.5, Grok, GPT-4o, Llama

## Project Structure

```
src/
├── config/      # Zod schema, env loading
├── providers/   # Anthropic LLM integration
├── tools/       # Read, Write, Edit, Bash
├── agent/       # Runtime loop, session management
├── channels/    # Telegram bot
├── gateway/     # Server orchestration
└── cli.ts       # CLI entry point
```

## Development

```bash
# Run tests
npm test

# Watch mode
npm run test:watch

# Type check
npm run typecheck

# Development with hot reload
npm run dev start
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes* | - | Anthropic API key |
| `OPENAI_API_KEY` | No | - | OpenAI API key |
| `GROQ_API_KEY` | No | - | Groq API key (for Llama) |
| `MOONSHOT_API_KEY` | No | - | Moonshot API key (for Kimi) |
| `XAI_API_KEY` | No | - | xAI API key (for Grok) |
| `TELEGRAM_BOT_TOKEN` | No | - | Telegram bot token |
| `TELEGRAM_ALLOWED_USERS` | No | - | Comma-separated user IDs (empty = allow all) |
| `TELEGRAM_VOICE_REPLY` | No | `false` | Reply with voice to voice messages |
| `AGENT_WORKSPACE` | No | `cwd()` | Working directory for agent |
| `AGENT_MAX_ITERATIONS` | No | `20` | Max tool calls per message |
| `LOG_LEVEL` | No | `info` | Logging level |

*At least one LLM provider API key is required.

### SOUL.md (Optional)

Create a `SOUL.md` in your workspace to customize agent behavior:

```markdown
# Agent Behavior

- Be concise
- Prefer code over explanations
- Always confirm destructive operations
```

## How It Works

1. **Message received** (Telegram or CLI)
2. **Session loaded** from JSONL file
3. **Agent loop**: LLM → Tool execution → Response
4. **Session saved** with new messages
5. **Response sent** back to user

The agent can chain up to 20 tool calls per message before responding.

## License

MIT

## Links

- [Milestones](./MILESTONES.md) - Development roadmap
- [Specification](./SPEC.md) - Full architecture details
