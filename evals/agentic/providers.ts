/**
 * Bench providers.
 *
 * `scripted` replays a task's reference solution deterministically, so the
 * harness itself is testable in CI with no network. Everything else is built
 * from the repo's real provider classes:
 *
 *   moonshot[:model]       MOONSHOT_API_KEY   (default model: MOONSHOT_MODEL or kimi-k2.5)
 *   openrouter:<model>     OPENROUTER_API_KEY (e.g. openrouter:qwen/qwen3.6-plus)
 *   openai[:model]         OPENAI_API_KEY     (+ OPENAI_BASE_URL)
 *   anthropic[:model]      ANTHROPIC_API_KEY
 *   local[:model]          LOCAL_BASE_URL     (OpenAI-compatible, e.g. the Dell)
 */

import {
  AnthropicProvider,
  MoonshotProvider,
  OpenAIProvider,
  OpenRouterProvider,
} from '../../src/providers/index.js';
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  LLMProvider,
  Message,
} from '../../src/providers/types.js';
import type { BenchTask } from './types.js';

export interface BenchModel {
  /** Spec as given on the command line, used as the result label. */
  label: string;
  /** Build a fresh provider for one task run. */
  create(task: BenchTask): LLMProvider;
  /** Enable provider thinking (mirrors the gateway's KIMI_THINKING_ENABLED for Moonshot). */
  enableThinking: boolean;
}

function textOf(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

function response(content: ContentBlock[], stopReason: CompletionResponse['stopReason']): CompletionResponse {
  const outputTokens = Math.ceil(JSON.stringify(content).length / 4);
  return { content, stopReason, usage: { inputTokens: 0, outputTokens }, model: 'scripted' };
}

/**
 * Deterministic model that replays `task.reference`.
 *
 * Position is derived from the request itself (stateless): the turn is the
 * latest user message that starts one of the task's prompts, and the step is
 * the number of assistant messages after it. Outcome-brain calls get the
 * candidate echoed back unchanged ("send"), which is what a cooperative
 * arbiter model would do; whatever the brain's sanitizer then strips is the
 * harness measuring the brain, not the scripted model. Review calls get LGTM.
 */
export class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly model = 'scripted';
  private fallbackTurn = 0;

  constructor(private readonly task: BenchTask) {}

  isAvailable(): boolean {
    return true;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const inputTokens = Math.ceil(JSON.stringify(request.messages).length / 4);
    const result = this.next(request);
    return { ...result, usage: { ...result.usage, inputTokens } };
  }

  private next(request: CompletionRequest): CompletionResponse {
    if (request.purpose === 'outcome_brain') {
      const last = request.messages[request.messages.length - 1];
      let candidates: string[] = [];
      try {
        candidates = (JSON.parse(textOf(last?.content ?? '')) as { candidates?: string[] }).candidates ?? [];
      } catch { /* fall through to an empty send */ }
      return response([{
        type: 'text',
        text: JSON.stringify({ decision: 'send', message: candidates.join('\n\n'), reason_code: 'scripted_echo' }),
      }], 'end_turn');
    }

    // Review-on-stop: a cooperative reviewer that finds nothing to fix.
    if (request.purpose === 'review') return response([{ type: 'text', text: 'LGTM' }], 'end_turn');

    const { turn, step } = this.locate(request.messages);
    const reference = this.task.reference[Math.min(turn, this.task.reference.length - 1)];
    if (!reference) return response([{ type: 'text', text: 'Done.' }], 'end_turn');
    if (!request.tools?.length || step >= reference.steps.length) {
      return response([{ type: 'text', text: reference.reply }], 'end_turn');
    }
    const calls = reference.steps[step]!;
    return response(
      calls.map((call, index) => ({
        type: 'tool_use' as const,
        id: `scripted-${turn}-${step}-${index}`,
        name: call.name,
        input: call.input,
      })),
      'tool_use',
    );
  }

  private locate(messages: readonly Message[]): { turn: number; step: number } {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role !== 'user') continue;
      const text = textOf(message.content);
      const turn = this.task.prompt.findIndex(prompt => text.includes(prompt.slice(0, 80)));
      if (turn < 0) continue;
      this.fallbackTurn = turn;
      const step = messages.slice(i + 1).filter(m => m.role === 'assistant').length;
      return { turn, step };
    }
    return { turn: this.fallbackTurn, step: Number.MAX_SAFE_INTEGER };
  }
}

function requireEnv(name: string, spec: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`--model ${spec} needs ${name} (set it in the environment or .env)`);
  return value;
}

/** Resolve a `--model` spec into a provider factory. */
export function resolveBenchModel(spec: string): BenchModel {
  const [kind, ...rest] = spec.split(':');
  const model = rest.join(':') || undefined;
  const timeout = 120_000;
  switch (kind) {
    case 'scripted':
      return { label: 'scripted', enableThinking: false, create: task => new ScriptedProvider(task) };
    case 'moonshot': {
      const apiKey = requireEnv('MOONSHOT_API_KEY', spec);
      const resolved = model ?? process.env.MOONSHOT_MODEL ?? 'kimi-k2.5';
      return {
        label: `moonshot:${resolved}`,
        enableThinking: process.env.KIMI_THINKING_ENABLED !== 'false',
        create: () => new MoonshotProvider({ apiKey, model: resolved, timeout }),
      };
    }
    case 'openrouter': {
      const apiKey = requireEnv('OPENROUTER_API_KEY', spec);
      const resolved = model ?? process.env.OPENROUTER_MODEL ?? 'qwen/qwen3.6-plus';
      return {
        label: `openrouter:${resolved}`,
        enableThinking: false,
        create: () => new OpenRouterProvider({ apiKey, model: resolved, timeout }),
      };
    }
    case 'openai': {
      const apiKey = requireEnv('OPENAI_API_KEY', spec);
      const resolved = model ?? process.env.OPENAI_MODEL ?? 'gpt-4o';
      const baseUrl = process.env.OPENAI_BASE_URL;
      return {
        label: `openai:${resolved}`,
        enableThinking: false,
        create: () => new OpenAIProvider({ apiKey, model: resolved, timeout, ...(baseUrl && { baseUrl }) }),
      };
    }
    case 'anthropic': {
      const apiKey = requireEnv('ANTHROPIC_API_KEY', spec);
      const resolved = model ?? process.env.ANTHROPIC_MODEL;
      return {
        label: `anthropic:${resolved ?? 'default'}`,
        enableThinking: false,
        create: () => new AnthropicProvider({ apiKey, timeout, ...(resolved && { model: resolved }) }),
      };
    }
    case 'local': {
      const baseUrl = requireEnv('LOCAL_BASE_URL', spec);
      const resolved = model ?? process.env.LOCAL_MODEL ?? 'qwen3.6';
      return {
        label: `local:${resolved}`,
        enableThinking: false,
        create: () => new OpenAIProvider({
          name: 'local',
          baseUrl,
          apiKey: process.env.LOCAL_API_KEY || 'sk-local',
          model: resolved,
          timeout: 600_000,
        }),
      };
    }
    default:
      throw new Error(`Unknown --model "${spec}". Use scripted | moonshot[:m] | openrouter:<m> | openai[:m] | anthropic[:m] | local[:m]`);
  }
}
