# LeanBot Development Milestones

> **Principle**: At the end of every milestone, everything works end-to-end. No half-built features.

---

## Overview

| Milestone | Name | Focus | Outcome |
|-----------|------|-------|---------|
| 1 | **MVP** | End-to-end working bot | Chat via Telegram, execute tasks, persist sessions |
| 2 | **Smart Routing** | Cost efficiency (the differentiator) | Tiered model routing, cost tracking, sliding window |
| 3 | **Full Features** | Feature parity + extras | Skills, multi-channel, cron, gardener memory |
| 4 | **Production Ready** | Polish & reliability | Caching, branching, dashboard, recovery |

---

# Milestone 1: MVP

**Goal**: A working personal AI assistant you can chat with on Telegram that executes tasks on your VPS.

**End State**:
- Send message on Telegram → LeanBot receives it → calls LLM → executes tools → responds
- Sessions persist across restarts
- Basic memory works

---

## 1.1 Project Setup

### 1.1.1 Initialize TypeScript Project

```
leanbot/
├── src/
│   ├── index.ts              # Entry point
│   ├── config/
│   │   ├── loader.ts         # Config file loading
│   │   └── schema.ts         # Config validation (Zod)
│   └── utils/
│       ├── logger.ts         # Structured logging (pino)
│       └── errors.ts         # Error types
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── .env.example
```

**Tasks**:
- [ ] Initialize pnpm project with TypeScript 5.x
- [ ] Set up tsconfig with strict mode, ESM output
- [ ] Add dev dependencies: `vitest`, `tsx`, `typescript`, `@types/node`
- [ ] Add runtime dependencies: `pino` (logging), `zod` (validation), `dotenv`
- [ ] Create basic config loader that reads `~/.leanbot/config.yaml` and env vars
- [ ] Set up vitest for unit tests
- [ ] Create logger with levels: debug, info, warn, error

**Config Schema** (Zod):
```typescript
const configSchema = z.object({
  providers: z.object({
    anthropic: z.object({
      apiKey: z.string(),
      defaultModel: z.string().default('claude-sonnet-4-5'),
    }).optional(),
  }),
  channels: z.object({
    telegram: z.object({
      enabled: z.boolean().default(false),
      botToken: z.string().optional(),
    }),
  }),
  agent: z.object({
    workspace: z.string().default('~/.leanbot/workspace'),
    sessionDir: z.string().default('~/.leanbot/sessions'),
  }),
});
```

---

### 1.1.2 CLI Framework

**Tasks**:
- [ ] Add `commander` for CLI parsing
- [ ] Implement subcommands:
  - `leanbot start` - Start the gateway
  - `leanbot chat` - Interactive CLI mode (for testing)
  - `leanbot config get/set` - Config management
  - `leanbot version` - Version info

**File**: `src/cli/index.ts`

```typescript
// Command structure
program
  .command('start')
  .description('Start LeanBot gateway')
  .option('--foreground', 'Run in foreground (not daemon)')
  .action(startGateway);

program
  .command('chat')
  .description('Interactive CLI chat')
  .action(startCliChat);
```

---

## 1.2 LLM Provider Layer

### 1.2.1 Provider Interface

**File**: `src/providers/types.ts`

```typescript
interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  // ... type-specific fields
}

interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JSONSchema;
}

interface CompletionRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  max_tokens?: number;
  system?: string;
}

interface CompletionResponse {
  id: string;
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface Provider {
  name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  streamComplete(request: CompletionRequest): AsyncIterable<CompletionChunk>;
}
```

---

### 1.2.2 Anthropic Provider Implementation

**File**: `src/providers/anthropic.ts`

**Dependencies**: `@anthropic-ai/sdk`

**Tasks**:
- [ ] Implement `AnthropicProvider` class
- [ ] Handle API key from config/env (`ANTHROPIC_API_KEY`)
- [ ] Implement `complete()` method using Messages API
- [ ] Implement `streamComplete()` for streaming responses
- [ ] Handle tool_use responses correctly
- [ ] Map Anthropic response format to internal format
- [ ] Add retry logic with exponential backoff (429, 500, 503)
- [ ] Track token usage in response

**Key Implementation Details**:
```typescript
class AnthropicProvider implements Provider {
  private client: Anthropic;

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.max_tokens ?? 4096,
      system: request.system,
      messages: this.mapMessages(request.messages),
      tools: request.tools?.map(this.mapTool),
    });

    return this.mapResponse(response);
  }
}
```

---

### 1.2.3 Provider Registry

**File**: `src/providers/registry.ts`

**Tasks**:
- [ ] Create `ProviderRegistry` class
- [ ] Load providers based on config (only load if API key present)
- [ ] Implement `getProvider(name: string)` method
- [ ] Implement `getDefaultProvider()` method

```typescript
class ProviderRegistry {
  private providers: Map<string, Provider> = new Map();

  register(provider: Provider): void;
  get(name: string): Provider | undefined;
  getDefault(): Provider;
}
```

---

## 1.3 Core Tools

### 1.3.1 Tool Interface

**File**: `src/tools/types.ts`

```typescript
interface ToolContext {
  workspace: string;      // Agent workspace directory
  sessionId: string;      // Current session ID
  logger: Logger;
}

interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}
```

---

### 1.3.2 Read Tool

**File**: `src/tools/read.ts`

**Capabilities**:
- Read file contents
- Support line range (offset + limit)
- Handle binary files (return base64 or error)
- Handle missing files gracefully

**Schema**:
```typescript
const readSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute or workspace-relative path' },
    offset: { type: 'number', description: 'Start line (1-indexed)' },
    limit: { type: 'number', description: 'Number of lines to read' },
  },
  required: ['path'],
};
```

**Tasks**:
- [ ] Implement file reading with `fs.promises.readFile`
- [ ] Add line number prefix to output (like `cat -n`)
- [ ] Handle encoding detection (utf-8 default)
- [ ] Truncate very large files (> 100KB) with warning
- [ ] Resolve relative paths against workspace

---

### 1.3.3 Write Tool

**File**: `src/tools/write.ts`

**Capabilities**:
- Write/overwrite file contents
- Create parent directories if needed
- Backup existing file before overwrite (optional)

**Schema**:
```typescript
const writeSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['path', 'content'],
};
```

**Tasks**:
- [ ] Implement file writing with `fs.promises.writeFile`
- [ ] Create parent directories with `fs.promises.mkdir({ recursive: true })`
- [ ] Return success message with file path and size

---

### 1.3.4 Edit Tool

**File**: `src/tools/edit.ts`

**Capabilities**:
- Find and replace text in file
- Support `old_string` → `new_string` replacement
- Support `replace_all` flag for multiple occurrences

**Schema**:
```typescript
const editSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    old_string: { type: 'string' },
    new_string: { type: 'string' },
    replace_all: { type: 'boolean', default: false },
  },
  required: ['path', 'old_string', 'new_string'],
};
```

**Tasks**:
- [ ] Read file, find `old_string`, replace with `new_string`
- [ ] Error if `old_string` not found
- [ ] Error if `old_string` found multiple times and `replace_all` is false
- [ ] Show diff-like output of changes

---

### 1.3.5 Bash Tool

**File**: `src/tools/bash.ts`

**Capabilities**:
- Execute shell commands
- Capture stdout, stderr, exit code
- Support timeout
- Support working directory

**Schema**:
```typescript
const bashSchema = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    timeout: { type: 'number', default: 120000 },
    cwd: { type: 'string', description: 'Working directory' },
  },
  required: ['command'],
};
```

**Tasks**:
- [ ] Use `child_process.spawn` with shell: true
- [ ] Capture stdout and stderr
- [ ] Implement timeout with process kill
- [ ] Return combined output with exit code
- [ ] Truncate very long output (> 30KB)

**Implementation Notes**:
```typescript
import { spawn } from 'child_process';

async function executeBash(command: string, options: BashOptions): Promise<ToolResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, {
      shell: true,
      cwd: options.cwd,
      timeout: options.timeout,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => stdout += data);
    proc.stderr.on('data', (data) => stderr += data);

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        output: `Exit code: ${code}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`,
      });
    });
  });
}
```

---

### 1.3.6 Tool Registry

**File**: `src/tools/registry.ts`

**Tasks**:
- [ ] Create `ToolRegistry` class
- [ ] Register all core tools
- [ ] Implement `getTool(name: string)` method
- [ ] Implement `getAllTools()` for LLM tool definitions
- [ ] Implement `executeTool(name, input, context)` method

```typescript
class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  getAll(): Tool[];
  getDefinitions(): ToolDefinition[];  // For LLM
  execute(name: string, input: unknown, context: ToolContext): Promise<ToolResult>;
}
```

---

## 1.4 Agent Runtime

### 1.4.1 Session Management

**File**: `src/agent/session.ts`

**Session Storage**: JSONL files at `~/.leanbot/sessions/<sessionId>.jsonl`

**Tasks**:
- [ ] Create `Session` class
- [ ] Implement JSONL append for new messages
- [ ] Implement JSONL read for session history
- [ ] Generate unique session IDs (nanoid)
- [ ] Support session metadata (created, updated, channel, etc.)

**Session JSONL Format**:
```jsonl
{"type":"meta","sessionId":"abc123","created":"2026-02-01T00:00:00Z","channel":"telegram"}
{"type":"message","role":"user","content":"Hello","timestamp":"..."}
{"type":"message","role":"assistant","content":"Hi!","timestamp":"..."}
{"type":"tool_use","name":"bash","input":{"command":"ls"},"timestamp":"..."}
{"type":"tool_result","name":"bash","output":"file1.txt\nfile2.txt","timestamp":"..."}
```

```typescript
class Session {
  id: string;
  filePath: string;

  async appendMessage(message: Message): Promise<void>;
  async getHistory(): Promise<Message[]>;
  async getMetadata(): Promise<SessionMetadata>;
}

class SessionManager {
  getOrCreate(sessionId: string): Promise<Session>;
  list(): Promise<SessionMetadata[]>;
}
```

---

### 1.4.2 Agent Loop

**File**: `src/agent/agent.ts`

**The core agent loop**:
1. Receive user message
2. Load session history
3. Build prompt (system + history + user message)
4. Call LLM
5. If tool_use → execute tool → add result → goto 4
6. If end_turn → return assistant response
7. Persist to session

**Tasks**:
- [ ] Create `Agent` class
- [ ] Implement `processMessage(sessionId, userMessage)` method
- [ ] Build system prompt from SOUL.md / defaults
- [ ] Handle tool calling loop
- [ ] Limit max iterations (prevent infinite loops)
- [ ] Return final response

```typescript
class Agent {
  private provider: Provider;
  private tools: ToolRegistry;
  private sessions: SessionManager;

  async processMessage(
    sessionId: string,
    userMessage: string
  ): Promise<string> {
    const session = await this.sessions.getOrCreate(sessionId);
    const history = await session.getHistory();

    // Add user message
    history.push({ role: 'user', content: userMessage });
    await session.appendMessage({ role: 'user', content: userMessage });

    // Agent loop
    let iterations = 0;
    const maxIterations = 20;

    while (iterations < maxIterations) {
      const response = await this.provider.complete({
        model: this.config.model,
        system: this.getSystemPrompt(),
        messages: history,
        tools: this.tools.getDefinitions(),
      });

      // Handle tool use
      if (response.stop_reason === 'tool_use') {
        for (const block of response.content) {
          if (block.type === 'tool_use') {
            const result = await this.tools.execute(
              block.name,
              block.input,
              this.getContext(session)
            );
            history.push({ role: 'assistant', content: [block] });
            history.push({
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: block.id,
                content: result.output,
              }],
            });
          }
        }
        iterations++;
        continue;
      }

      // End turn - extract text response
      const textContent = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      await session.appendMessage({ role: 'assistant', content: textContent });
      return textContent;
    }

    throw new Error('Max iterations exceeded');
  }
}
```

---

### 1.4.3 System Prompt

**File**: `src/agent/prompt.ts`

**Default System Prompt** (based on SOUL.md):
```typescript
const DEFAULT_SYSTEM_PROMPT = `
You are LeanBot, an efficient personal AI assistant running on the user's VPS.

## Core Values
- Efficiency over verbosity
- Actions over explanations
- Results over process narration

## Behavioral Rules
- Never say "I'd be happy to help" - just help
- Never explain what you're about to do - just do it
- If a task takes 1 tool call, don't use 5
- Keep responses under 200 tokens unless complexity demands more

## Available Tools
You have access to: read, write, edit, bash

## Workspace
Your workspace is: {workspace}
All file paths should be relative to this directory unless absolute.
`;
```

**Tasks**:
- [ ] Create prompt builder function
- [ ] Support loading custom SOUL.md from workspace
- [ ] Inject dynamic values (workspace path, date, etc.)

---

## 1.5 Telegram Channel

### 1.5.1 grammY Bot Setup

**File**: `src/channels/telegram/bot.ts`

**Dependencies**: `grammy`

**Tasks**:
- [ ] Create `TelegramChannel` class
- [ ] Initialize grammY bot with token from config
- [ ] Set up long-polling (default, no webhook complexity for MVP)
- [ ] Handle incoming text messages
- [ ] Handle `/start` command (welcome message)
- [ ] Handle `/reset` command (clear session)

```typescript
import { Bot } from 'grammy';

class TelegramChannel {
  private bot: Bot;
  private agent: Agent;

  constructor(token: string, agent: Agent) {
    this.bot = new Bot(token);
    this.agent = agent;
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.bot.command('start', (ctx) => {
      ctx.reply('LeanBot is ready. Send me a message.');
    });

    this.bot.command('reset', async (ctx) => {
      // Clear session for this chat
      await this.resetSession(ctx.chat.id);
      ctx.reply('Session cleared.');
    });

    this.bot.on('message:text', async (ctx) => {
      const sessionId = `telegram:${ctx.chat.id}`;
      const response = await this.agent.processMessage(
        sessionId,
        ctx.message.text
      );
      await ctx.reply(response);
    });
  }

  async start(): Promise<void> {
    await this.bot.start();
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
```

---

### 1.5.2 Message Formatting

**File**: `src/channels/telegram/formatter.ts`

**Tasks**:
- [ ] Convert markdown to Telegram HTML
- [ ] Handle code blocks with `<pre><code>` tags
- [ ] Handle long messages (split at 4096 chars)
- [ ] Escape special HTML characters

```typescript
function formatForTelegram(text: string): string[] {
  // Convert markdown to Telegram HTML
  let html = text
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.*?)\*/g, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');

  // Split into chunks if too long
  return splitMessage(html, 4096);
}
```

---

### 1.5.3 Typing Indicator

**Tasks**:
- [ ] Send typing indicator while processing
- [ ] Keep sending every 5s for long operations

```typescript
async function withTyping<T>(
  ctx: Context,
  operation: () => Promise<T>
): Promise<T> {
  const interval = setInterval(() => {
    ctx.replyWithChatAction('typing');
  }, 5000);

  ctx.replyWithChatAction('typing');

  try {
    return await operation();
  } finally {
    clearInterval(interval);
  }
}
```

---

## 1.6 Gateway Server

### 1.6.1 Main Gateway

**File**: `src/gateway/index.ts`

**Tasks**:
- [ ] Create `Gateway` class that orchestrates everything
- [ ] Initialize config, logger
- [ ] Initialize provider registry
- [ ] Initialize tool registry
- [ ] Initialize session manager
- [ ] Initialize agent
- [ ] Initialize channels (Telegram)
- [ ] Implement graceful shutdown (SIGTERM, SIGINT)

```typescript
class Gateway {
  private config: Config;
  private logger: Logger;
  private providers: ProviderRegistry;
  private tools: ToolRegistry;
  private sessions: SessionManager;
  private agent: Agent;
  private channels: Channel[];

  async start(): Promise<void> {
    this.logger.info('Starting LeanBot gateway...');

    // Initialize providers
    this.providers = new ProviderRegistry(this.config);

    // Initialize tools
    this.tools = new ToolRegistry();
    this.tools.register(new ReadTool());
    this.tools.register(new WriteTool());
    this.tools.register(new EditTool());
    this.tools.register(new BashTool());

    // Initialize sessions
    this.sessions = new SessionManager(this.config.agent.sessionDir);

    // Initialize agent
    this.agent = new Agent({
      provider: this.providers.getDefault(),
      tools: this.tools,
      sessions: this.sessions,
      workspace: this.config.agent.workspace,
    });

    // Initialize channels
    if (this.config.channels.telegram.enabled) {
      const telegram = new TelegramChannel(
        this.config.channels.telegram.botToken,
        this.agent
      );
      await telegram.start();
      this.channels.push(telegram);
    }

    this.logger.info('LeanBot gateway started');
  }

  async stop(): Promise<void> {
    this.logger.info('Shutting down...');
    for (const channel of this.channels) {
      await channel.stop();
    }
    this.logger.info('Shutdown complete');
  }
}
```

---

### 1.6.2 CLI Entry Point

**File**: `src/index.ts`

```typescript
import { program } from 'commander';
import { Gateway } from './gateway';
import { loadConfig } from './config/loader';

program
  .command('start')
  .description('Start LeanBot gateway')
  .action(async () => {
    const config = await loadConfig();
    const gateway = new Gateway(config);

    // Handle shutdown signals
    process.on('SIGTERM', () => gateway.stop());
    process.on('SIGINT', () => gateway.stop());

    await gateway.start();
  });

program.parse();
```

---

## 1.7 MVP Testing & Verification

### 1.7.1 Unit Tests

**Tasks**:
- [ ] Test config loading
- [ ] Test each tool in isolation
- [ ] Test session JSONL read/write
- [ ] Test message formatting

### 1.7.2 Integration Tests

**Tasks**:
- [ ] Test agent loop with mock provider
- [ ] Test tool execution chain
- [ ] Test session persistence across restarts

### 1.7.3 Manual E2E Testing

**Checklist**:
- [ ] `leanbot start` runs without errors
- [ ] Telegram bot responds to `/start`
- [ ] Send "Hello" → get response
- [ ] Send "Create a file called test.txt with content 'hello world'" → file created
- [ ] Send "Read test.txt" → shows content
- [ ] Send "Run ls -la" → shows directory listing
- [ ] Restart gateway → session history preserved
- [ ] `/reset` clears session

---

## MVP Deliverables

| Component | Files | Status |
|-----------|-------|--------|
| Config | `src/config/*.ts` | [ ] |
| Logging | `src/utils/logger.ts` | [ ] |
| Anthropic Provider | `src/providers/anthropic.ts` | [ ] |
| Read Tool | `src/tools/read.ts` | [ ] |
| Write Tool | `src/tools/write.ts` | [ ] |
| Edit Tool | `src/tools/edit.ts` | [ ] |
| Bash Tool | `src/tools/bash.ts` | [ ] |
| Tool Registry | `src/tools/registry.ts` | [ ] |
| Session Manager | `src/agent/session.ts` | [ ] |
| Agent | `src/agent/agent.ts` | [ ] |
| Telegram Channel | `src/channels/telegram/*.ts` | [ ] |
| Gateway | `src/gateway/index.ts` | [ ] |
| CLI | `src/cli/index.ts` | [ ] |

---

# Milestone 2: Smart Routing

**Goal**: Implement LeanBot's key differentiator - intelligent cost optimization through tiered model routing and context management.

**End State**:
- Automatic complexity-based model selection
- Real-time cost tracking
- Sliding window context (not full history)
- Multiple LLM providers

---

## 2.1 Complexity Analyzer

### 2.1.1 Complexity Detection

**File**: `src/router/complexity.ts`

**Complexity Tiers**:
- `trivial`: Simple queries, greetings, yes/no questions
- `simple`: Summarization, file operations, simple coding
- `moderate`: Code review, debugging, multi-step tasks
- `complex`: Architecture, system design, complex reasoning

**Detection Signals**:
```typescript
interface ComplexitySignals {
  tokenCount: number;
  hasCode: boolean;
  hasArchitectureKeywords: boolean;
  hasDebugKeywords: boolean;
  hasSimpleKeywords: boolean;
  toolsLikelyNeeded: string[];
  questionDepth: number;  // Simple question vs multi-part
}

function analyzeComplexity(input: string): ComplexityTier {
  const signals = extractSignals(input);

  // Trivial: < 20 tokens, no code, simple keywords
  if (signals.tokenCount < 20 && !signals.hasCode && signals.hasSimpleKeywords) {
    return 'trivial';
  }

  // Complex: architecture keywords, debug keywords, or very long
  if (signals.hasArchitectureKeywords || signals.hasDebugKeywords || signals.tokenCount > 500) {
    return 'complex';
  }

  // Moderate: code present, or multiple tools needed
  if (signals.hasCode || signals.toolsLikelyNeeded.length > 2) {
    return 'moderate';
  }

  return 'simple';
}
```

**Tasks**:
- [ ] Implement token counting (tiktoken or simple word-based estimate)
- [ ] Implement keyword detection for each tier
- [ ] Implement code detection (markdown code blocks, keywords)
- [ ] Implement tool prediction based on input
- [ ] Add historical accuracy tracking (learn from results)

---

### 2.1.2 Model Selector

**File**: `src/router/selector.ts`

**Tasks**:
- [ ] Create `ModelSelector` class
- [ ] Map complexity tiers to model lists from config
- [ ] Select first available model from tier
- [ ] Handle fallback to next tier if preferred not available

```typescript
class ModelSelector {
  private config: RoutingConfig;

  selectModel(tier: ComplexityTier): { provider: string; model: string } {
    const tierConfig = this.config.tiers[tier];

    for (const modelSpec of tierConfig.models) {
      const [provider, model] = modelSpec.split('/');
      if (this.isAvailable(provider)) {
        return { provider, model };
      }
    }

    // Fallback to next tier up
    return this.selectModel(this.getNextTier(tier));
  }
}
```

---

## 2.2 Multiple Providers

### 2.2.1 OpenAI Provider

**File**: `src/providers/openai.ts`

**Dependencies**: `openai`

**Tasks**:
- [ ] Implement `OpenAIProvider` class
- [ ] Handle API key from config/env
- [ ] Map internal format to OpenAI Chat Completions format
- [ ] Handle tool calls (function calling)
- [ ] Implement streaming

---

### 2.2.2 Groq Provider

**File**: `src/providers/groq.ts`

**Tasks**:
- [ ] Implement `GroqProvider` class (OpenAI-compatible API)
- [ ] Configure base URL for Groq
- [ ] Handle Groq-specific rate limits

---

### 2.2.3 Ollama Provider (Local)

**File**: `src/providers/ollama.ts`

**Tasks**:
- [ ] Implement `OllamaProvider` class
- [ ] Auto-detect Ollama at `http://127.0.0.1:11434`
- [ ] List available models
- [ ] Handle OpenAI-compatible completions endpoint

---

### 2.2.4 OpenRouter Provider

**File**: `src/providers/openrouter.ts`

**Tasks**:
- [ ] Implement `OpenRouterProvider` class
- [ ] Support multi-provider model specs (e.g., `openrouter/anthropic/claude-sonnet`)
- [ ] Handle OpenRouter-specific headers

---

## 2.3 Cost Tracking

### 2.3.1 Usage Tracker

**File**: `src/budget/tracker.ts`

**Model Pricing** (per 1M tokens):
```typescript
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'anthropic/claude-opus-4-5': { input: 15, output: 75 },
  'anthropic/claude-sonnet-4-5': { input: 3, output: 15 },
  'anthropic/claude-haiku-3-5': { input: 0.25, output: 1.25 },
  'openai/gpt-4o': { input: 2.5, output: 10 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
  'groq/llama-3.3-70b': { input: 0.59, output: 0.79 },
  // ... etc
};
```

**Tasks**:
- [ ] Create `UsageTracker` class
- [ ] Track per-request: model, input_tokens, output_tokens, cost
- [ ] Track per-session totals
- [ ] Track daily totals
- [ ] Persist to `~/.leanbot/usage/YYYY-MM-DD.jsonl`
- [ ] Implement `getToday()`, `getSession()`, `getTotal()` methods

```typescript
interface UsageRecord {
  timestamp: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  tier: ComplexityTier;
}

class UsageTracker {
  async record(usage: UsageRecord): Promise<void>;
  async getToday(): Promise<UsageSummary>;
  async getSession(sessionId: string): Promise<UsageSummary>;
}
```

---

### 2.3.2 Budget Guardian

**File**: `src/budget/guardian.ts`

**Tasks**:
- [ ] Create `BudgetGuardian` class
- [ ] Check budget before each request
- [ ] Implement daily/monthly limits
- [ ] Return allowed/denied with reason
- [ ] Suggest tier downgrade if near limit

```typescript
class BudgetGuardian {
  async checkBudget(estimatedCost: number): Promise<BudgetDecision> {
    const today = await this.tracker.getToday();

    if (today.cost + estimatedCost > this.config.dailyLimit) {
      return {
        allowed: false,
        reason: 'Daily budget exceeded',
        suggestion: 'Use cheaper model or wait until tomorrow',
      };
    }

    if (today.cost + estimatedCost > this.config.dailyLimit * 0.75) {
      return {
        allowed: true,
        warning: 'Approaching daily budget limit (75%)',
      };
    }

    return { allowed: true };
  }
}
```

---

## 2.4 Sliding Window Context

### 2.4.1 Context Manager

**File**: `src/context/manager.ts`

**Strategy**:
- Keep last N messages verbatim (hot window)
- Compress older messages into summary (warm summary)
- Full history on disk (cold storage)

**Tasks**:
- [ ] Create `ContextManager` class
- [ ] Implement `buildContext(session, maxTokens)` method
- [ ] Count tokens in messages
- [ ] Select recent messages up to token budget
- [ ] Generate summary of older messages (using cheap model)

```typescript
class ContextManager {
  private hotWindowSize: number = 5;  // Last 5 messages
  private warmSummaryTokens: number = 500;
  private maxContextTokens: number = 32000;

  async buildContext(session: Session): Promise<Message[]> {
    const history = await session.getHistory();

    // Always include hot window
    const hotWindow = history.slice(-this.hotWindowSize);
    const hotTokens = this.countTokens(hotWindow);

    // Check if we need compression
    const totalTokens = this.countTokens(history);
    if (totalTokens <= this.maxContextTokens) {
      return history;  // No compression needed
    }

    // Generate summary of older messages
    const olderMessages = history.slice(0, -this.hotWindowSize);
    const summary = await this.generateSummary(olderMessages);

    return [
      { role: 'system', content: `Previous context summary:\n${summary}` },
      ...hotWindow,
    ];
  }

  private async generateSummary(messages: Message[]): Promise<string> {
    // Use cheapest available model for summarization
    const response = await this.cheapProvider.complete({
      model: 'anthropic/claude-haiku-3-5',
      messages: [
        {
          role: 'user',
          content: `Summarize the key points from this conversation in under ${this.warmSummaryTokens} tokens:\n\n${this.formatMessages(messages)}`,
        },
      ],
      max_tokens: this.warmSummaryTokens,
    });

    return response.content[0].text;
  }
}
```

---

### 2.4.2 Tool Output Truncation

**File**: `src/context/truncator.ts`

**Tasks**:
- [ ] Create `OutputTruncator` class
- [ ] Truncate tool outputs > N tokens
- [ ] Keep head + tail + "... truncated ..." message
- [ ] Store full output in cache with hash reference
- [ ] Support `recall(hash)` tool to retrieve full output

```typescript
class OutputTruncator {
  private maxTokens: number = 2000;
  private cache: Map<string, string> = new Map();

  truncate(output: string): { truncated: string; hash?: string } {
    const tokens = this.countTokens(output);

    if (tokens <= this.maxTokens) {
      return { truncated: output };
    }

    // Store full output
    const hash = this.hash(output);
    this.cache.set(hash, output);

    // Truncate with head + tail
    const lines = output.split('\n');
    const headLines = lines.slice(0, 50);
    const tailLines = lines.slice(-20);

    const truncated = [
      ...headLines,
      `\n... [${lines.length - 70} lines truncated, use recall("${hash}") to retrieve] ...\n`,
      ...tailLines,
    ].join('\n');

    return { truncated, hash };
  }
}
```

---

## 2.5 Smart Router Integration

### 2.5.1 Router Class

**File**: `src/router/router.ts`

**Tasks**:
- [ ] Create `SmartRouter` class that combines all components
- [ ] Implement `route(input, session)` method
- [ ] Return selected model, estimated cost, context

```typescript
class SmartRouter {
  private complexity: ComplexityAnalyzer;
  private selector: ModelSelector;
  private budget: BudgetGuardian;
  private context: ContextManager;

  async route(input: string, session: Session): Promise<RouteDecision> {
    // Analyze complexity
    const tier = this.complexity.analyze(input);

    // Select model
    const { provider, model } = this.selector.selectModel(tier);

    // Estimate cost
    const estimatedCost = this.estimateCost(input, model);

    // Check budget
    const budgetCheck = await this.budget.checkBudget(estimatedCost);
    if (!budgetCheck.allowed) {
      // Try cheaper tier
      const cheaperTier = this.getPreviousTier(tier);
      if (cheaperTier) {
        return this.route(input, session);  // Recurse with cheaper tier
      }
      throw new BudgetExceededError(budgetCheck.reason);
    }

    // Build context
    const context = await this.context.buildContext(session);

    return {
      provider,
      model,
      tier,
      estimatedCost,
      context,
      budgetWarning: budgetCheck.warning,
    };
  }
}
```

---

### 2.5.2 Update Agent to Use Router

**File**: `src/agent/agent.ts` (update)

**Tasks**:
- [ ] Inject `SmartRouter` into Agent
- [ ] Use router for each request
- [ ] Log tier, model, cost for each request
- [ ] Include budget warnings in response if applicable

---

## 2.6 Milestone 2 Testing

### 2.6.1 Tests

**Tasks**:
- [ ] Test complexity analyzer with various inputs
- [ ] Test model selector with different configs
- [ ] Test budget guardian limits
- [ ] Test context manager compression
- [ ] Test end-to-end routing

### 2.6.2 Manual Verification

**Checklist**:
- [ ] Simple query ("hi") → uses Haiku/cheap model
- [ ] Complex query ("architect a system...") → uses Opus/expensive model
- [ ] Cost tracked and displayed in logs
- [ ] Long conversation → context compressed correctly
- [ ] Budget warning at 75%
- [ ] Budget hard stop at 100%

---

## Milestone 2 Deliverables

| Component | Files | Status |
|-----------|-------|--------|
| Complexity Analyzer | `src/router/complexity.ts` | [ ] |
| Model Selector | `src/router/selector.ts` | [ ] |
| OpenAI Provider | `src/providers/openai.ts` | [ ] |
| Groq Provider | `src/providers/groq.ts` | [ ] |
| Ollama Provider | `src/providers/ollama.ts` | [ ] |
| OpenRouter Provider | `src/providers/openrouter.ts` | [ ] |
| Usage Tracker | `src/budget/tracker.ts` | [ ] |
| Budget Guardian | `src/budget/guardian.ts` | [ ] |
| Context Manager | `src/context/manager.ts` | [ ] |
| Output Truncator | `src/context/truncator.ts` | [ ] |
| Smart Router | `src/router/router.ts` | [ ] |
| Agent Updates | `src/agent/agent.ts` | [ ] |

---

# Milestone 3: Full Features

**Goal**: Feature parity with OpenClaw plus LeanBot-specific enhancements.

**End State**:
- Multiple channels (Telegram, Discord, CLI)
- Skill system with ClawHub compatibility
- Cron scheduler
- Gardener memory architecture
- Memory search

---

## 3.1 Additional Channels

### 3.1.1 Discord Channel

**File**: `src/channels/discord/bot.ts`

**Dependencies**: `discord.js`

**Tasks**:
- [ ] Create `DiscordChannel` class
- [ ] Handle text messages in allowed channels
- [ ] Handle DMs
- [ ] Handle slash commands (`/leanbot`, `/reset`)
- [ ] Support mentions for activation in groups
- [ ] Format responses for Discord (markdown, embeds)

---

### 3.1.2 CLI Channel

**File**: `src/channels/cli/repl.ts`

**Tasks**:
- [ ] Create interactive REPL for `leanbot chat`
- [ ] Support multi-line input
- [ ] Show typing indicator (spinner)
- [ ] Support `/commands` (reset, status, etc.)
- [ ] Syntax highlighting for code in responses

---

### 3.1.3 Channel Manager

**File**: `src/channels/manager.ts`

**Tasks**:
- [ ] Create `ChannelManager` class
- [ ] Initialize enabled channels from config
- [ ] Provide unified interface for notifications
- [ ] Route outbound messages to correct channel

---

## 3.2 Skill System

### 3.2.1 SKILL.md Parser

**File**: `src/skills/parser.ts`

**Tasks**:
- [ ] Parse SKILL.md YAML frontmatter
- [ ] Extract: name, description, metadata, requirements
- [ ] Parse instruction body (markdown)
- [ ] Validate against schema

```typescript
interface SkillDefinition {
  name: string;
  description: string;
  homepage?: string;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  metadata?: {
    openclaw?: {
      emoji?: string;
      requires?: {
        bins?: string[];
        env?: string[];
        config?: string[];
      };
      os?: string[];
    };
    leanbot?: {
      complexity?: ComplexityTier;
      maxTokens?: number;
      cacheable?: boolean;
    };
  };
  instructions: string;
}
```

---

### 3.2.2 Skill Loader

**File**: `src/skills/loader.ts`

**Tasks**:
- [ ] Load skills from multiple paths (precedence order)
- [ ] Check gating requirements (bins, env, os)
- [ ] Register loaded skills
- [ ] Support lazy loading (load full skill on demand)

```typescript
class SkillLoader {
  private paths = [
    '{workspace}/skills',      // Highest priority
    '~/.leanbot/skills',
    '~/.leanbot/clawhub',
    '{bundled}/skills',        // Lowest priority
  ];

  async loadAll(): Promise<SkillDefinition[]>;
  async load(name: string): Promise<SkillDefinition>;
  checkRequirements(skill: SkillDefinition): { met: boolean; missing: string[] };
}
```

---

### 3.2.3 ClawHub Client

**File**: `src/skills/clawhub.ts`

**Tasks**:
- [ ] Implement ClawHub API client
- [ ] Search skills by query
- [ ] Download/install skills
- [ ] Update installed skills
- [ ] CLI commands: `leanbot skill search/install/update/list`

---

### 3.2.4 Skill Injection

**File**: `src/skills/injector.ts`

**Tasks**:
- [ ] Inject skill instructions into system prompt when relevant
- [ ] Detect skill relevance from user input
- [ ] Manage skill context budget (don't load all skills)

---

## 3.3 Cron Scheduler

### 3.3.1 Cron Parser

**File**: `src/cron/parser.ts`

**Dependencies**: `cron-parser`

**Tasks**:
- [ ] Parse cron expressions
- [ ] Calculate next run time
- [ ] Support standard cron syntax

---

### 3.3.2 Cron Scheduler

**File**: `src/cron/scheduler.ts`

**Tasks**:
- [ ] Create `CronScheduler` class
- [ ] Load cron jobs from config
- [ ] Schedule jobs with `node-cron` or custom scheduler
- [ ] Execute jobs at scheduled times
- [ ] Handle job output (send to channel or store)
- [ ] Support built-in actions: `ping`, `status`

```typescript
interface CronJob {
  name: string;
  schedule: string;          // Cron expression
  action: string;            // Prompt or built-in action
  channel?: string;          // Output channel
  tier?: ComplexityTier;     // Model tier override
  silent?: boolean;          // Don't notify user
  condition?: string;        // Only run if condition met
}

class CronScheduler {
  private jobs: Map<string, ScheduledJob> = new Map();

  async start(): Promise<void>;
  async stop(): Promise<void>;
  async runJob(name: string): Promise<void>;
  async listJobs(): Promise<CronJobStatus[]>;
}
```

---

### 3.3.3 Built-in Cron Actions

**File**: `src/cron/builtins.ts`

**Tasks**:
- [ ] Implement `ping` action (lightweight keepalive)
- [ ] Implement `status` action (system status report)
- [ ] Implement `backup` action (backup memory/sessions)

---

## 3.4 Gardener Memory

### 3.4.1 Hot Collector

**File**: `src/memory/collector.ts`

**Tasks**:
- [ ] Append interactions to daily log (`memory/YYYY-MM-DD.jsonl`)
- [ ] Minimal processing during conversation
- [ ] Store: input, output, tools used, timestamps

---

### 3.4.2 Gardener Process

**File**: `src/memory/gardener.ts`

**Tasks**:
- [ ] Create background process (runs every N minutes)
- [ ] Read unprocessed daily logs
- [ ] Extract atomic facts using cheap model
- [ ] Build entity links
- [ ] Update structured files
- [ ] Generate summaries

```typescript
class Gardener {
  private interval: number = 5 * 60 * 1000;  // 5 minutes

  async run(): Promise<void> {
    // Get unprocessed logs
    const logs = await this.getUnprocessedLogs();

    // Extract facts
    for (const log of logs) {
      const facts = await this.extractFacts(log);
      await this.storeFacts(facts);
    }

    // Update summaries
    await this.updateDailySummary();
    await this.updateWeeklySummary();

    // Mark as processed
    await this.markProcessed(logs);
  }

  private async extractFacts(log: LogEntry): Promise<Fact[]> {
    const response = await this.cheapModel.complete({
      messages: [{
        role: 'user',
        content: `Extract atomic facts from this interaction. Format as JSON array of {fact, entities[], category}.

Interaction:
User: ${log.input}
Assistant: ${log.output}

Facts:`,
      }],
    });

    return JSON.parse(response.content[0].text);
  }
}
```

---

### 3.4.3 Structured Fact Storage

**File**: `src/memory/facts.ts`

**Storage Structure**:
```
~/.leanbot/memory/
├── facts/
│   ├── entities.json       # People, projects, tools
│   ├── preferences.json    # User preferences
│   ├── decisions.json      # Decisions with rationale
│   └── learnings.json      # What worked/didn't
├── summaries/
│   ├── daily/
│   │   └── 2026-02-01.md
│   ├── weekly/
│   │   └── 2026-W05.md
│   └── topics/
│       └── project-x.md
└── raw/
    └── 2026-02-01.jsonl    # Raw daily logs
```

**Tasks**:
- [ ] Implement fact CRUD operations
- [ ] Implement entity linking
- [ ] Implement fact deduplication
- [ ] Implement fact expiration/pruning

---

### 3.4.4 Memory Search

**File**: `src/memory/search.ts`

**Tasks**:
- [ ] Implement hybrid search (vector + BM25)
- [ ] Use SQLite with FTS5 for keyword search
- [ ] Use local embeddings (or API) for vector search
- [ ] Combine scores with configurable weights
- [ ] Add `memory_search` tool

```typescript
class MemorySearch {
  async search(query: string, limit: number = 10): Promise<SearchResult[]> {
    // Vector search
    const vectorResults = await this.vectorSearch(query, limit * 2);

    // BM25 search
    const keywordResults = await this.keywordSearch(query, limit * 2);

    // Merge and rank
    return this.mergeResults(vectorResults, keywordResults, limit);
  }
}
```

---

## 3.5 Milestone 3 Deliverables

| Component | Files | Status |
|-----------|-------|--------|
| Discord Channel | `src/channels/discord/*.ts` | [ ] |
| CLI Channel | `src/channels/cli/*.ts` | [ ] |
| Channel Manager | `src/channels/manager.ts` | [ ] |
| SKILL.md Parser | `src/skills/parser.ts` | [ ] |
| Skill Loader | `src/skills/loader.ts` | [ ] |
| ClawHub Client | `src/skills/clawhub.ts` | [ ] |
| Skill Injector | `src/skills/injector.ts` | [ ] |
| Cron Parser | `src/cron/parser.ts` | [ ] |
| Cron Scheduler | `src/cron/scheduler.ts` | [ ] |
| Cron Builtins | `src/cron/builtins.ts` | [ ] |
| Hot Collector | `src/memory/collector.ts` | [ ] |
| Gardener | `src/memory/gardener.ts` | [ ] |
| Fact Storage | `src/memory/facts.ts` | [ ] |
| Memory Search | `src/memory/search.ts` | [ ] |

---

# Milestone 4: Production Ready

**Goal**: Polish, reliability, and production deployment features.

**End State**:
- Response caching
- Session branching
- Cost dashboard CLI
- Systemd integration
- Degraded mode handling
- Crash recovery

---

## 4.1 Response Caching

### 4.1.1 Cache Layer

**File**: `src/cache/response.ts`

**Tasks**:
- [ ] Implement semantic response cache
- [ ] Hash input + context for cache key
- [ ] Configurable TTL
- [ ] Similarity threshold for cache hits
- [ ] Cache invalidation

```typescript
class ResponseCache {
  async get(input: string, context: string): Promise<CachedResponse | null> {
    const key = this.hashKey(input, context);
    const cached = await this.storage.get(key);

    if (cached && !this.isExpired(cached)) {
      return cached;
    }

    // Try semantic match
    const similar = await this.findSimilar(input, context);
    if (similar && similar.similarity > this.threshold) {
      return similar.response;
    }

    return null;
  }

  async set(input: string, context: string, response: string): Promise<void>;
}
```

---

### 4.1.2 Tool Output Cache

**File**: `src/cache/tools.ts`

**Tasks**:
- [ ] Cache deterministic tool outputs
- [ ] Key by tool name + input hash
- [ ] Support `recall(hash)` for truncated outputs
- [ ] Auto-expire stale caches

---

## 4.2 Session Branching

### 4.2.1 Branch Manager

**File**: `src/agent/branching.ts`

**Tasks**:
- [ ] Support creating sub-branches from main conversation
- [ ] Track branch parent and merge point
- [ ] Summarize branch and merge back to main
- [ ] Discard failed branches without pollution

```typescript
class BranchManager {
  async createBranch(session: Session, purpose: string): Promise<Branch> {
    return {
      id: nanoid(),
      parentSession: session.id,
      parentMessageIndex: session.messageCount,
      purpose,
      messages: [],
    };
  }

  async mergeBranch(branch: Branch, session: Session): Promise<void> {
    const summary = await this.summarizeBranch(branch);
    await session.appendMessage({
      role: 'system',
      content: `[Branch "${branch.purpose}" completed: ${summary}]`,
    });
  }

  async discardBranch(branch: Branch): Promise<void> {
    // Just don't merge - branch is orphaned
  }
}
```

---

## 4.3 Cost Dashboard

### 4.3.1 Dashboard CLI

**File**: `src/budget/dashboard.ts`

**Tasks**:
- [ ] Implement `leanbot budget` command
- [ ] Show current session cost
- [ ] Show today's cost vs budget
- [ ] Show monthly projection
- [ ] Show savings vs naive approach
- [ ] Show model usage breakdown

```
┌─────────────────────────────────────────────────────────────────┐
│  LEANBOT COST DASHBOARD                          Session #47    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Current Session:                                               │
│  ├── Tokens used: 12,450 (input: 10,200 | output: 2,250)       │
│  ├── Cost: $0.08                                                │
│  ├── Models used: haiku (85%), sonnet (15%)                    │
│  └── Cache hits: 23 (saved ~8,000 tokens)                      │
│                                                                 │
│  Today:                                                         │
│  ├── Total cost: $1.24                                          │
│  ├── Budget remaining: $3.76 / $5.00                           │
│  └── Projected monthly: $37.20                                  │
│                                                                 │
│  Savings vs naive approach: 78% ($4.40 saved today)            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4.4 Systemd Integration

### 4.4.1 Daemon Mode

**File**: `src/daemon/index.ts`

**Tasks**:
- [ ] Implement `leanbot daemon start/stop/status`
- [ ] PID file management
- [ ] Foreground vs background mode
- [ ] Startup validation (check config, API keys)

---

### 4.4.2 Systemd Service

**File**: `scripts/leanbot.service`

```ini
[Unit]
Description=LeanBot AI Assistant
After=network.target

[Service]
Type=simple
User=%i
ExecStart=/usr/local/bin/leanbot start --foreground
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

**Tasks**:
- [ ] Implement `leanbot daemon install` (creates systemd service)
- [ ] Implement `leanbot daemon uninstall`
- [ ] Support `sudo systemctl enable/start/stop leanbot`

---

## 4.5 Degraded Mode

### 4.5.1 Fallback Chain

**File**: `src/router/fallback.ts`

**Tasks**:
- [ ] Implement provider health checking
- [ ] Automatic fallback on errors (429, 500, 503)
- [ ] Cooldown tracking per provider
- [ ] Graceful degradation to local models

---

### 4.5.2 Budget Exhaustion Handling

**File**: `src/budget/exhaustion.ts`

**Tasks**:
- [ ] Queue non-urgent tasks when budget low
- [ ] Notify user of budget status
- [ ] Allow manual override
- [ ] Resume queued tasks on budget reset

---

## 4.6 Crash Recovery

### 4.6.1 State Persistence

**File**: `src/recovery/state.ts`

**Tasks**:
- [ ] Persist in-progress task state
- [ ] Store: task description, progress, last action
- [ ] Detect incomplete tasks on startup

---

### 4.6.2 Recovery Dialog

**File**: `src/recovery/dialog.ts`

**Tasks**:
- [ ] Check for incomplete tasks on startup
- [ ] Prompt user via active channel
- [ ] Options: resume, restart, abort
- [ ] Execute chosen recovery action

---

## 4.7 Proactive Notifications

### 4.7.1 Notification Manager

**File**: `src/notifications/manager.ts`

**Tasks**:
- [ ] Create `NotificationManager` class
- [ ] Send notifications to configured channel
- [ ] Support notification types: info, warning, error, success
- [ ] Respect quiet hours (optional)

---

### 4.7.2 Event Triggers

**Tasks**:
- [ ] Cron job completion → notify
- [ ] Cron job failure → notify (always)
- [ ] Task completion → notify
- [ ] Error occurred → notify (always)
- [ ] Budget warning (75%) → notify
- [ ] Budget exhausted → notify (always)

---

## 4.8 Onboarding Flow

### 4.8.1 Setup Wizard

**File**: `src/cli/onboard.ts`

**Tasks**:
- [ ] Implement `leanbot init` interactive wizard
- [ ] Prompt for API keys
- [ ] Prompt for Telegram bot token
- [ ] Set up default config
- [ ] Create workspace directories
- [ ] Validate setup

---

## 4.9 Milestone 4 Deliverables

| Component | Files | Status |
|-----------|-------|--------|
| Response Cache | `src/cache/response.ts` | [ ] |
| Tool Output Cache | `src/cache/tools.ts` | [ ] |
| Branch Manager | `src/agent/branching.ts` | [ ] |
| Dashboard CLI | `src/budget/dashboard.ts` | [ ] |
| Daemon Mode | `src/daemon/index.ts` | [ ] |
| Systemd Service | `scripts/leanbot.service` | [ ] |
| Fallback Chain | `src/router/fallback.ts` | [ ] |
| Budget Exhaustion | `src/budget/exhaustion.ts` | [ ] |
| State Persistence | `src/recovery/state.ts` | [ ] |
| Recovery Dialog | `src/recovery/dialog.ts` | [ ] |
| Notification Manager | `src/notifications/manager.ts` | [ ] |
| Onboarding Wizard | `src/cli/onboard.ts` | [ ] |

---

# Summary

| Milestone | Focus | Key Deliverables |
|-----------|-------|------------------|
| **1: MVP** | End-to-end working | Gateway, Telegram, Agent, Core Tools, Sessions |
| **2: Smart Routing** | Cost efficiency | Complexity Analyzer, Multi-provider, Budget, Context Management |
| **3: Full Features** | Feature parity | Skills, Discord, CLI, Cron, Gardener Memory, Search |
| **4: Production** | Polish & reliability | Caching, Branching, Dashboard, Systemd, Recovery |

---

## Dependencies Summary

### Core
- `typescript` ^5.0
- `pino` (logging)
- `zod` (validation)
- `commander` (CLI)
- `dotenv`
- `nanoid`

### Providers
- `@anthropic-ai/sdk`
- `openai`
- `grammy` (Telegram)
- `discord.js`

### Utilities
- `tiktoken` (token counting)
- `cron-parser`
- `better-sqlite3` (memory search)
- `yaml` (config parsing)

### Dev
- `vitest`
- `tsx`
- `@types/node`
