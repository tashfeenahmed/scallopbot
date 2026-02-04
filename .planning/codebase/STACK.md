# Technology Stack

**Analysis Date:** 2026-02-04

## Languages

**Primary:**
- TypeScript 5.0+ - All application code (`src/**/*.ts`)

**Secondary:**
- JavaScript (ES2022) - Compiled output (`dist/`)

## Runtime

**Environment:**
- Node.js (ES2022 target)
- ESM modules (`"type": "module"` in `package.json`)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` present

## Frameworks

**Core:**
- None (vanilla Node.js with TypeScript)

**Testing:**
- Vitest 2.0 - Unit and integration tests (`vitest.config.ts`)

**Build/Dev:**
- TypeScript Compiler (tsc) - Build tool
- tsx - Dev runner for TypeScript (`tsx watch src/index.ts`)

## Key Dependencies

**LLM Providers:**
- `@anthropic-ai/sdk ^0.72.1` - Claude models (`src/providers/anthropic.ts`)
- `openai ^6.17.0` - GPT models, TTS, STT (`src/providers/openai.ts`)
- `groq-sdk ^0.37.0` - Llama, fast inference (`src/providers/groq.ts`)

**Messaging Platforms:**
- `grammy ^1.39.3` - Telegram bot (`src/channels/telegram.ts`)
- `discord.js ^14.25.1` - Discord bot (`src/channels/discord.ts`)

**Data & Storage:**
- `better-sqlite3 ^12.6.2` - SQLite database (`src/memory/db.ts`)
- `zod ^4.3.6` - Schema validation (`src/config/config.ts`)

**Utilities:**
- `pino ^10.3.0` - Structured logging (`src/utils/logger.ts`)
- `commander ^14.0.3` - CLI interface (`src/cli.ts`)
- `node-cron ^4.2.1` - Task scheduling (`src/scheduler/`)
- `nanoid ^5.1.6` - ID generation
- `ws ^8.19.0` - WebSocket server (`src/gateway/`)

**Optional (in optionalDependencies):**
- `@slack/bolt ^4.3.1` - Slack integration
- `@whiskeysockets/baileys ^6.7.17` - WhatsApp
- `matrix-js-sdk ^36.2.0` - Matrix protocol
- `playwright ^1.50.0` - Browser automation

## Configuration

**Environment:**
- `.env` files via `dotenv ^17.2.3`
- Schema validation via Zod in `src/config/config.ts`

**Required env vars:**
- `ANTHROPIC_API_KEY` (at least one LLM provider)
- `TELEGRAM_BOT_TOKEN` (for Telegram channel)
- `AGENT_WORKSPACE` (working directory)

**Build:**
- `tsconfig.json` - TypeScript compiler options (ES2022, strict mode)
- `vitest.config.ts` - Test runner configuration
- `eslint.config.js` - Linting rules

## Platform Requirements

**Development:**
- macOS/Linux/Windows (any platform with Node.js)
- No external dependencies required

**Production:**
- Node.js runtime
- PM2 recommended (`ecosystem.config.cjs`)
- Optional: Tailscale for secure remote access

---

*Stack analysis: 2026-02-04*
*Update after major dependency changes*
