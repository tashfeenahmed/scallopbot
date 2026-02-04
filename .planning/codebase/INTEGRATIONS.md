# External Integrations

**Analysis Date:** 2026-02-04

## APIs & External Services

**LLM Providers:**

| Provider | SDK | Models | Auth Env Var |
|----------|-----|--------|--------------|
| Anthropic | `@anthropic-ai/sdk ^0.72.1` | claude-opus-4-5, claude-sonnet-4 | `ANTHROPIC_API_KEY` |
| OpenAI | `openai ^6.17.0` | gpt-4o | `OPENAI_API_KEY` |
| Groq | `groq-sdk ^0.37.0` | llama-3.3-70b-versatile | `GROQ_API_KEY` |
| xAI | `openai ^6.17.0` (compatible) | grok-4, grok-3 | `XAI_API_KEY` |
| Moonshot | `openai ^6.17.0` (compatible) | kimi-k2.5 | `MOONSHOT_API_KEY` |
| OpenRouter | REST API | 200+ models | `OPENROUTER_API_KEY` |
| Ollama | HTTP API | Any local model | None (localhost) |

**Implementation files:**
- `src/providers/anthropic.ts`
- `src/providers/openai.ts`
- `src/providers/groq.ts`
- `src/providers/xai.ts`
- `src/providers/moonshot.ts`
- `src/providers/openrouter.ts`
- `src/providers/ollama.ts`

**Web Search:**
- Brave Search API - `src/tools/search.ts`
  - Auth: `BRAVE_SEARCH_API_KEY` env var
  - Used for: Web search without CAPTCHA issues

## Messaging Platforms

**Telegram** (`src/channels/telegram.ts`):
- Framework: `grammy ^1.39.3`
- Auth: `TELEGRAM_BOT_TOKEN`
- Features: Voice support, user allowlist
- Config: `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_VOICE_REPLY`

**Discord** (`src/channels/discord.ts`):
- SDK: `discord.js ^14.25.1`
- Auth: `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`
- Features: Slash commands, streaming messages

**Slack** (`src/channels/slack.ts`):
- SDK: `@slack/bolt ^4.3.1` (optional)
- Auth: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`
- Modes: Socket mode or HTTP

**WhatsApp** (`src/channels/whatsapp.ts`):
- SDK: `@whiskeysockets/baileys ^6.7.17` (optional)
- Auth: QR code scan on first run
- Protocol: WhatsApp Web reverse-engineered

**Signal** (`src/channels/signal.ts`):
- Bridge: signal-cli (Java CLI)
- Auth: Phone number registration
- Setup: External signal-cli installation required

**Matrix** (`src/channels/matrix.ts`):
- SDK: `matrix-js-sdk ^36.2.0` (optional)
- Auth: Access token or username/password
- Servers: matrix.org, element.io, self-hosted

## Data Storage

**Databases:**
- SQLite via `better-sqlite3 ^12.6.2`
  - Connection: File-based (`memories.db`)
  - Client: Direct SQL with better-sqlite3
  - Location: `src/memory/db.ts`
  - Mode: WAL for concurrency

**Session Storage:**
- JSONL files in `sessions/` directory
- Thread-safe locking via `src/agent/session.ts`

**File Storage:**
- Local filesystem only
- No cloud storage integration

**Caching:**
- In-memory cache (`src/cache/cache.ts`)
- No external cache service (Redis, etc.)

## Voice Services

**Speech-to-Text (STT):**
- OpenAI Whisper API - `src/voice/stt/cloud/openai.ts`
- Groq Whisper API - `src/voice/stt/cloud/groq.ts`
- Local Whisper - `src/voice/stt/local/whisper.ts`
- macOS native - `src/voice/stt/local/macos.ts`

**Text-to-Speech (TTS):**
- OpenAI TTS API - `src/voice/tts/cloud/openai.ts`
- Piper (local) - `src/voice/tts/local/piper.ts`
- macOS native - `src/voice/tts/local/macos.ts`

## Browser Automation

**Playwright** (`src/tools/browser/`):
- SDK: `playwright ^1.50.0` (optional)
- Features: Web scraping, screenshots, interaction
- Session management with singleton pattern
- Proxy support via `BROWSER_PROXY`

## Networking & Infrastructure

**WebSocket Server:**
- Library: `ws ^8.19.0`
- Location: `src/gateway/`
- Default: localhost:3000

**Tailscale Integration:**
- Location: `src/tailscale/tailscale.ts`
- Modes: off, serve, funnel
- Features: Secure remote access

## Environment Configuration

**Development:**
- Required: At least one LLM API key
- Template: `.env.example` provided
- Validation: Zod schemas in `src/config/config.ts`

**Production:**
- PM2 recommended (`ecosystem.config.cjs`)
- Secrets: Environment variables
- Logging: Pino structured output

## Skills & Extensions

**Clawhub Integration** (`src/skills/clawhub.ts`):
- Download and execute custom AI skills
- Package management system
- Security: Dynamic import whitelisting

**Bundled Skills:**
- Docker - `src/skills/bundled/docker/`
- Git - `src/skills/bundled/git/`
- npm - `src/skills/bundled/npm/`

## Webhooks & Callbacks

**Incoming:**
- None - uses long-polling for messaging platforms

**Outgoing:**
- None configured

---

*Integration audit: 2026-02-04*
*Update when adding/removing external services*
