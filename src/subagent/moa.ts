/**
 * Mixture of Agents (optional, behind MOA_ENABLED, default off).
 *
 * 2–3 advisor models read the conversation in parallel and give short advice
 * (approach, pitfalls, what to check). The advice is attached as a trailing
 * user message with a `[moa-advice: …]` header; the main model then acts.
 * Advisors never call tools. A slow or failing advisor is simply dropped.
 *
 * Export only — the caller decides when to use it (e.g. capable-tier turns
 * or an explicit /moa).
 */

import type { LLMProvider, Message, ContentBlock } from '../providers/types.js';
import type { Router } from '../routing/router.js';

export interface MoaAdvice {
  provider: string;
  model?: string;
  text: string;
}

export interface MoaOptions {
  /** Advisor providers (2–3 recommended). */
  advisors: LLMProvider[];
  /** Per-advisor timeout. Default 45s. */
  timeoutMs?: number;
  /** Max output tokens per advisor. Default 1200. */
  maxTokens?: number;
  /** Cap on each advisor's advice text. Default 4000 chars. */
  maxAdviceChars?: number;
  /** Only the most recent N messages are shown to advisors. Default 30. */
  maxMessages?: number;
  /** Optional system prompt override for advisors. */
  system?: string;
  signal?: AbortSignal;
}

export const MOA_ADVISOR_SYSTEM = [
  'You are an advisor to another AI assistant that will act on this conversation.',
  'Do not answer the user directly and do not call tools.',
  'In under 200 words give: the best approach, the likely pitfalls, and what must be verified.',
  'If the assistant is going wrong, say so plainly.',
].join(' ');

export function isMoaEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(?:1|true|yes|on)$/i.test((env.MOA_ENABLED ?? '').trim());
}

/** Flatten tool traffic to text so any advisor model can read the transcript. */
function flattenForAdvisor(messages: Message[], maxMessages: number): Message[] {
  const flattened = messages.slice(-maxMessages).map((message): Message => {
    if (typeof message.content === 'string') return message;
    const text = (message.content as ContentBlock[]).map(block => {
      switch (block.type) {
        case 'text': return block.text;
        case 'tool_use': return `[tool call ${block.name} ${JSON.stringify(block.input).slice(0, 500)}]`;
        case 'tool_result': return `[tool result${block.is_error ? ' (error)' : ''}] ${block.content.slice(0, 1_500)}`;
        case 'image': return '[image]';
        default: return '';
      }
    }).filter(Boolean).join('\n');
    return { role: message.role, content: text || '(empty)' };
  });
  // Providers want the transcript to start with a user turn.
  while (flattened.length > 0 && flattened[0].role !== 'user') flattened.shift();
  return flattened;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`advisor timed out after ${ms}ms`)), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Ask every advisor in parallel; returns the advice that came back in time. */
export async function gatherAdvice(messages: Message[], opts: MoaOptions): Promise<MoaAdvice[]> {
  const transcript = flattenForAdvisor(messages, opts.maxMessages ?? 30);
  if (transcript.length === 0 || opts.advisors.length === 0) return [];
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const maxChars = opts.maxAdviceChars ?? 4_000;
  const settled = await Promise.allSettled(opts.advisors.map(async (advisor): Promise<MoaAdvice> => {
    const response = await withTimeout(advisor.complete({
      messages: transcript,
      system: opts.system ?? MOA_ADVISOR_SYSTEM,
      maxTokens: opts.maxTokens ?? 1_200,
      temperature: 0.4,
      signal: opts.signal,
    }), timeoutMs);
    const text = response.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();
    return { provider: advisor.name, model: response.model ?? advisor.model, text: text.slice(0, maxChars) };
  }));
  return settled
    .filter((outcome): outcome is PromiseFulfilledResult<MoaAdvice> => outcome.status === 'fulfilled' && !!outcome.value.text)
    .map(outcome => outcome.value);
}

/** `[moa-advice: N advisors] …` — advice for the main model, not from the user. */
export function formatAdviceMessage(advice: MoaAdvice[]): string {
  const sections = advice.map((item, index) =>
    `### Advisor ${index + 1} (${item.model ? `${item.provider}/${item.model}` : item.provider})\n${item.text}`);
  return [
    `[moa-advice: ${advice.length} advisor${advice.length === 1 ? '' : 's'}] (advice from other models, not the user — weigh it; you decide and act)`,
    ...sections,
  ].join('\n\n');
}

/**
 * Return `messages` with the advice attached as a trailing user message. When
 * the conversation already ends on a user turn, the advice is appended to it
 * as an extra text block so roles keep alternating. No advice → unchanged.
 */
export async function withMoaAdvice(messages: Message[], opts: MoaOptions): Promise<{ messages: Message[]; advice: MoaAdvice[] }> {
  const advice = await gatherAdvice(messages, opts);
  if (advice.length === 0) return { messages, advice };
  const adviceText = formatAdviceMessage(advice);
  const last = messages.at(-1);
  if (last?.role === 'user') {
    const blocks: ContentBlock[] = typeof last.content === 'string'
      ? [{ type: 'text', text: last.content }]
      : [...last.content];
    blocks.push({ type: 'text', text: adviceText });
    return { messages: [...messages.slice(0, -1), { role: 'user', content: blocks }], advice };
  }
  return { messages: [...messages, { role: 'user', content: adviceText }], advice };
}

/**
 * Pick up to `count` distinct healthy advisors, capable tier first, skipping
 * the main provider. Returns [] when fewer than 2 are available (MoA with one
 * advisor is just a second opinion — the caller may still use it).
 */
export function selectAdvisors(router: Router, opts: { count?: number; exclude?: string[] } = {}): LLMProvider[] {
  const count = Math.max(1, Math.min(3, opts.count ?? 3));
  const exclude = new Set(opts.exclude ?? []);
  const mapping = router.getTierMapping();
  const picked: LLMProvider[] = [];
  for (const name of [...mapping.capable, ...mapping.standard]) {
    if (picked.length >= count) break;
    if (exclude.has(name) || picked.some(provider => provider.name === name)) continue;
    if (!router.canAttemptProvider(name)) continue;
    const provider = router.getProvider(name);
    if (provider) picked.push(provider);
  }
  return picked;
}
