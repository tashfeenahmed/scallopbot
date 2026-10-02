/**
 * Background learning fork (Hermes style).
 *
 * After the reply has gone out, a review replays the session (same system
 * prompt + messages, so the provider's prompt cache hits) plus one review
 * instruction, and lets the model act with ONLY learning tools: core memory,
 * skill authoring (verified + versioned), load_procedure, read_file and,
 * when available, session_search. At most 16 iterations.
 *
 * Triggers: every 10 user turns, every 10 tool calls, after compaction, and on
 * explicit user corrections. Scheduling never blocks the caller (setImmediate),
 * and reviews are single-flight per session; a trigger that arrives while a
 * review runs is coalesced into one follow-up run.
 */

import { readFile, realpath, stat } from 'fs/promises';
import { isAbsolute, resolve, sep } from 'path';
import type { Logger } from 'pino';
import type {
  ContentBlock,
  LLMProvider,
  Message,
  SystemPrompt,
  ToolDefinition,
  ToolResultContent,
  ToolUseContent,
} from '../providers/types.js';
import type { Skill, SkillHandlerContext } from '../skills/types.js';

export const REVIEW_MAX_ITERATIONS = 16;
export const REVIEW_TURN_INTERVAL = 10;
export const REVIEW_TOOL_CALL_INTERVAL = 10;

export type ReviewReason = 'turns' | 'tool_calls' | 'compaction' | 'user_correction';

export const BACKGROUND_REVIEW_PROMPT = `[kind: background-review] This message is from the harness, not the user. The conversation above is over; nobody is waiting for a reply.

Review this session and capture what will make future sessions better. Be ACTIVE — most sessions teach something.

Order of preference for procedures:
1. Patch a skill that was used this session (missing step, wrong order, pitfall, better check).
2. Otherwise patch an umbrella skill that covers this class of task.
3. Otherwise add a references file to the relevant skill (write_reference) for detail that does not belong in the main steps.
4. Otherwise create a new class-level skill (general enough to reuse; never named after one specific instance).

Rules:
- Write lessons, not logs: state what to do and why, not what happened today.
- User corrections are first-class signals. If the user corrected you ("no, I meant", "that's wrong", "don't do X"), capture the corrected behaviour.
- Do not capture transient or environment failures (timeouts, rate limits, network blips, a missing binary on this machine) as lessons.
- Core memory holds declarative facts about the user and their environment/preferences. Prefer replacing or merging an existing entry over adding a near-duplicate; if a block is over its cap, consolidate first.
- Never store secrets, credentials or one-off personal details in skills.
- Use load_procedure / skill_manage view to read a skill before patching it.
- When done, reply with one short line listing what you changed, or "Nothing to save." if nothing was worth keeping.`;

const CORRECTION_PATTERNS: RegExp[] = [
  /\bno[,.!]?\s+(?:i|we)\s+(?:meant|mean|said|wanted|asked)\b/i,
  /\b(?:that'?s|that is|this is|you'?re|you are)\s+(?:wrong|incorrect|not (?:right|correct|what i (?:asked|wanted|meant)))\b/i,
  /\bi\s+(?:told|asked)\s+you\b/i,
  /\bi\s+(?:already\s+)?said\b.{0,40}\b(?:not|don'?t|never|before)\b/i,
  /\b(?:don'?t|do not|never|stop)\s+(?:do(?:ing)?|use|using|add(?:ing)?|send(?:ing)?|make|making|call(?:ing)?|put(?:ting)?|run(?:ning)?)\b/i,
  /\bnot what i (?:asked|wanted|meant)\b/i,
  /\bwhy (?:did|do) you (?:keep|always)\b/i,
  /\byou (?:forgot|missed|ignored|keep (?:doing|getting))\b/i,
  /\b(?:wrong|incorrect)[,.!]\s+(?:it'?s|it is|use|try)\b/i,
  /\bplease (?:don'?t|stop)\b/i,
  /^\s*(?:no|nope|wrong)[,.!]\s+\S/i,
];

/** Heuristic: does this user message explicitly correct the assistant? */
export function detectUserCorrection(message: string | undefined | null): boolean {
  if (!message) return false;
  const text = message.trim();
  if (!text || text.length > 2000) return false;
  return CORRECTION_PATTERNS.some(pattern => pattern.test(text));
}

export interface ReviewTriggerInput {
  sessionId: string;
  userId: string;
  /** Cumulative user turns in this session. */
  turnCount: number;
  /** Cumulative tool calls in this session. */
  toolCallCount: number;
  /** A compaction happened during this turn. */
  compacted?: boolean;
  /** true, or the user message text to check with detectUserCorrection. */
  userCorrection?: boolean | string;
}

/** A tool the review loop can execute. */
export interface ReviewTool {
  definition: ToolDefinition;
  execute(input: Record<string, unknown>, ctx: { sessionId: string; userId: string }): Promise<{ success: boolean; output: string; error?: string }>;
}

export interface ReviewReplay {
  /** The session's frozen system prompt (byte-identical for a cache hit). */
  system: string | SystemPrompt;
  /** Session messages, as last sent to the provider. */
  messages: Message[];
  /**
   * Optional: the tool definitions the session was sent with. When given they
   * are sent unchanged (keeps the tools prefix cached); only review tools can
   * actually run. When omitted, only the review tools are sent.
   */
  tools?: ToolDefinition[];
}

export interface BackgroundReviewDeps {
  /** Provider for the review (usually the session's main provider, for cache hits). */
  getProvider: (ctx: { sessionId: string; userId: string }) => LLMProvider | undefined | Promise<LLMProvider | undefined>;
  /** Replay of the session to review; null skips the review. */
  getReplay: (sessionId: string, userId: string) => ReviewReplay | null | Promise<ReviewReplay | null>;
  /** Review tools for this session (core memory, skill_manage, load_procedure, read_file, session_search?). */
  getTools: (ctx: { sessionId: string; userId: string }) => ReviewTool[] | Promise<ReviewTool[]>;
  maxIterations?: number;
  turnInterval?: number;
  toolCallInterval?: number;
  maxTokens?: number;
  /** Defaults to setImmediate; tests can run synchronously. */
  schedule?: (fn: () => void) => void;
  logger?: Logger;
  onComplete?: (summary: ReviewSummary) => void;
}

export interface ReviewSummary {
  sessionId: string;
  userId: string;
  reasons: ReviewReason[];
  iterations: number;
  toolCalls: Array<{ name: string; success: boolean }>;
  finalText: string;
  error?: string;
}

interface SessionReviewState {
  lastTurnCount: number;
  lastToolCallCount: number;
  running: boolean;
  pending: Set<ReviewReason> | null;
  userId: string;
  promise?: Promise<void>;
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();
}

/** Append the review instruction while keeping user/assistant alternation. */
export function appendReviewInstruction(messages: Message[], instruction: string): Message[] {
  const copy = [...messages];
  const last = copy[copy.length - 1];
  if (last && last.role === 'user') {
    const blocks: ContentBlock[] = typeof last.content === 'string'
      ? [{ type: 'text', text: last.content }]
      : [...last.content];
    blocks.push({ type: 'text', text: instruction });
    copy[copy.length - 1] = { role: 'user', content: blocks };
  } else {
    copy.push({ role: 'user', content: instruction });
  }
  return copy;
}

export class BackgroundReviewer {
  private readonly sessions = new Map<string, SessionReviewState>();
  private readonly maxIterations: number;
  private readonly turnInterval: number;
  private readonly toolCallInterval: number;
  private readonly schedule: (fn: () => void) => void;

  constructor(private readonly deps: BackgroundReviewDeps) {
    this.maxIterations = deps.maxIterations ?? REVIEW_MAX_ITERATIONS;
    this.turnInterval = deps.turnInterval ?? REVIEW_TURN_INTERVAL;
    this.toolCallInterval = deps.toolCallInterval ?? REVIEW_TOOL_CALL_INTERVAL;
    this.schedule = deps.schedule ?? (fn => { setImmediate(fn); });
  }

  /** Which triggers fire for this turn (pure; does not update counters). */
  reasonsFor(input: ReviewTriggerInput): ReviewReason[] {
    const state = this.sessions.get(input.sessionId);
    const lastTurns = state?.lastTurnCount ?? 0;
    const lastTools = state?.lastToolCallCount ?? 0;
    const reasons: ReviewReason[] = [];
    if (input.turnCount - lastTurns >= this.turnInterval) reasons.push('turns');
    if (input.toolCallCount - lastTools >= this.toolCallInterval) reasons.push('tool_calls');
    if (input.compacted) reasons.push('compaction');
    const corrected = typeof input.userCorrection === 'string'
      ? detectUserCorrection(input.userCorrection)
      : input.userCorrection === true;
    if (corrected) reasons.push('user_correction');
    return reasons;
  }

  /**
   * Call once after each reply has been sent. Returns immediately; the review
   * (if any) runs on a later tick and never throws into the caller.
   */
  maybeScheduleReview(input: ReviewTriggerInput): { scheduled: boolean; reasons: ReviewReason[] } {
    const reasons = this.reasonsFor(input);
    if (reasons.length === 0) return { scheduled: false, reasons };
    const state = this.sessions.get(input.sessionId) ?? {
      lastTurnCount: 0,
      lastToolCallCount: 0,
      running: false,
      pending: null,
      userId: input.userId,
    };
    state.lastTurnCount = input.turnCount;
    state.lastToolCallCount = input.toolCallCount;
    state.userId = input.userId;
    this.sessions.set(input.sessionId, state);

    if (state.running) {
      state.pending = new Set([...(state.pending ?? []), ...reasons]);
      return { scheduled: true, reasons };
    }
    this.start(input.sessionId, state, reasons);
    return { scheduled: true, reasons };
  }

  private start(sessionId: string, state: SessionReviewState, reasons: ReviewReason[]): void {
    state.running = true;
    state.promise = new Promise<void>(resolveRun => {
      this.schedule(() => {
        this.runReview(sessionId, state.userId, reasons)
          .then(summary => {
            try {
              this.deps.onComplete?.(summary);
            } catch {
              // Observers must not break the loop.
            }
          })
          .catch(() => undefined)
          .finally(() => {
            state.running = false;
            const pending = state.pending;
            state.pending = null;
            if (pending && pending.size > 0) this.start(sessionId, state, [...pending]);
            resolveRun();
          });
      });
    });
  }

  /** Resolves when every scheduled/in-flight review (including follow-ups) has finished. */
  async idle(): Promise<void> {
    for (;;) {
      const running = [...this.sessions.values()].filter(state => state.running && state.promise);
      if (running.length === 0) return;
      await Promise.all(running.map(state => state.promise));
    }
  }

  isRunning(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.running ?? false;
  }

  /** Forget a session's counters (e.g. on /new). */
  reset(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state && !state.running) this.sessions.delete(sessionId);
  }

  /** Run one review now (the scheduler calls this; exposed for tests/CLI). */
  async runReview(sessionId: string, userId: string, reasons: ReviewReason[]): Promise<ReviewSummary> {
    const summary: ReviewSummary = { sessionId, userId, reasons, iterations: 0, toolCalls: [], finalText: '' };
    const ctx = { sessionId, userId };
    try {
      const [provider, replay, tools] = await Promise.all([
        this.deps.getProvider(ctx),
        this.deps.getReplay(sessionId, userId),
        this.deps.getTools(ctx),
      ]);
      if (!provider || !replay || replay.messages.length === 0 || tools.length === 0) {
        summary.error = !provider ? 'no_provider' : !replay || replay.messages.length === 0 ? 'no_replay' : 'no_tools';
        return summary;
      }
      const toolByName = new Map(tools.map(tool => [tool.definition.name, tool]));
      const toolDefs = replay.tools && replay.tools.length > 0
        ? mergeToolDefinitions(replay.tools, tools.map(tool => tool.definition))
        : tools.map(tool => tool.definition);
      const instruction = `${BACKGROUND_REVIEW_PROMPT}\n\nWhy this review ran: ${reasons.join(', ')}. ` +
        `Tools you can use now: ${[...toolByName.keys()].join(', ')}.`;
      const messages = appendReviewInstruction(replay.messages, instruction);

      for (let i = 0; i < this.maxIterations; i++) {
        summary.iterations = i + 1;
        const response = await provider.complete({
          system: replay.system,
          messages,
          tools: toolDefs,
          maxTokens: this.deps.maxTokens ?? 4096,
          purpose: 'background_review',
          traceSessionId: sessionId,
        });
        messages.push({ role: 'assistant', content: response.content });
        const toolUses = response.content.filter((block): block is ToolUseContent => block.type === 'tool_use');
        if (toolUses.length === 0) {
          summary.finalText = textOf(response.content);
          break;
        }
        const results: ToolResultContent[] = [];
        for (const use of toolUses) {
          const tool = toolByName.get(use.name);
          if (!tool) {
            results.push({
              type: 'tool_result',
              tool_use_id: use.id,
              content: `"${use.name}" is not available during background review. Available: ${[...toolByName.keys()].join(', ')}.`,
              is_error: true,
            });
            summary.toolCalls.push({ name: use.name, success: false });
            continue;
          }
          let result: { success: boolean; output: string; error?: string };
          try {
            result = await tool.execute(use.input ?? {}, ctx);
          } catch (error) {
            result = { success: false, output: '', error: (error as Error).message };
          }
          summary.toolCalls.push({ name: use.name, success: result.success });
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: (result.success ? result.output : (result.output || result.error || 'failed')).slice(0, 16_000) || '(no output)',
            ...(result.success ? {} : { is_error: true }),
          });
        }
        messages.push({ role: 'user', content: results });
      }
      this.deps.logger?.info(
        { sessionId, reasons, iterations: summary.iterations, toolCalls: summary.toolCalls.length },
        'Background review finished',
      );
    } catch (error) {
      summary.error = (error as Error).message;
      this.deps.logger?.warn({ sessionId, error: summary.error }, 'Background review failed (non-fatal)');
    }
    return summary;
  }
}

/** Keep the session's tool list byte-identical and append review tools it lacks. */
function mergeToolDefinitions(session: ToolDefinition[], review: ToolDefinition[]): ToolDefinition[] {
  const names = new Set(session.map(tool => tool.name));
  return [...session, ...review.filter(tool => !names.has(tool.name))];
}

// ─── Tool adapters ─────────────────────────────────────────────────────

/** Wrap a native (in-process) skill as a review tool. */
export function reviewToolFromSkill(
  skill: Skill,
  base: { workspace: string },
): ReviewTool | null {
  const handler = skill.handler;
  if (!handler) return null;
  return {
    definition: {
      name: skill.name,
      description: skill.description,
      input_schema: skill.frontmatter.inputSchema ?? { type: 'object', properties: {} },
    },
    execute: (input, ctx) => handler({
      args: input,
      workspace: base.workspace,
      sessionId: ctx.sessionId,
      userId: ctx.userId,
    } as SkillHandlerContext),
  };
}

/** Pick named native skills from a registry as review tools (missing ones are skipped). */
export function reviewToolsFromRegistry(
  registry: { getSkill(name: string): Skill | undefined },
  names: string[],
  base: { workspace: string },
): ReviewTool[] {
  return names
    .map(name => registry.getSkill(name))
    .filter((skill): skill is Skill => !!skill && skill.available !== false)
    .map(skill => reviewToolFromSkill(skill, base))
    .filter((tool): tool is ReviewTool => !!tool);
}

/**
 * Minimal read-only read_file for the review fork, confined to `roots`
 * (e.g. the workspace and the skills dirs). Returns numbered lines.
 */
export function createReviewReadFileTool(options: { roots: string[]; maxBytes?: number; maxLines?: number }): ReviewTool {
  const maxBytes = options.maxBytes ?? 256 * 1024;
  const maxLines = options.maxLines ?? 2000;
  return {
    definition: {
      name: 'read_file',
      description: 'Read a text file (read-only). Returns LINE|CONTENT. Paths must be inside the workspace or skills folders.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute, or relative to the workspace)' },
          offset: { type: 'number', description: 'First line (1-based)' },
          limit: { type: 'number', description: 'Number of lines' },
        },
        required: ['path'],
      },
    },
    async execute(input) {
      const raw = typeof input.path === 'string' ? input.path.trim() : '';
      if (!raw) return { success: false, output: '', error: 'path is required' };
      const roots = await Promise.all(options.roots.map(root => realpath(root).catch(() => resolve(root))));
      const candidate = isAbsolute(raw) ? raw : resolve(roots[0] ?? '.', raw);
      let real: string;
      try {
        real = await realpath(candidate);
      } catch {
        return { success: false, output: '', error: `File not found: ${raw}` };
      }
      if (!roots.some(root => real === root || real.startsWith(root + sep))) {
        return { success: false, output: '', error: 'Path is outside the allowed folders.' };
      }
      const info = await stat(real);
      if (!info.isFile()) return { success: false, output: '', error: 'Not a regular file.' };
      if (info.size > maxBytes) return { success: false, output: '', error: `File is larger than ${maxBytes} bytes.` };
      const text = await readFile(real, 'utf8');
      if (text.includes('\0')) return { success: false, output: '', error: 'Binary file.' };
      const lines = text.split('\n');
      const offset = Math.max(1, Number(input.offset) || 1);
      const limit = Math.max(1, Math.min(maxLines, Number(input.limit) || maxLines));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const body = slice.map((line, index) => `${offset + index}|${line}`).join('\n');
      const more = offset - 1 + limit < lines.length ? `\n[${lines.length - (offset - 1 + limit)} more lines]` : '';
      return { success: true, output: body + more };
    },
  };
}
