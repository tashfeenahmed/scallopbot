/**
 * Model self-identity for the system prompt.
 *
 * Models can't introspect their own weights, so when asked "which model are
 * you?" a small local model will confabulate — typically grabbing a salient
 * proper noun from its injected memory/context (e.g. a person's name) and
 * inventing a system name around it. We prevent that by telling the bot, in the
 * system prompt, which model it actually runs on. Derived at runtime from the
 * active chat provider so it generalizes to every scallopbot instance and tracks
 * the live `/model` switch and PROVIDER_ORDER cascade without per-bot config.
 */

import type { LLMProvider } from '../providers/types.js';
import type { Router } from '../routing/router.js';

/**
 * The provider that will normally answer a chat turn: the first available
 * provider in PROVIDER_ORDER (mirrors Router.selectProvider's ordering), or the
 * given fallback when there's no router / nothing available. Read-only — no
 * health mutation, safe to call while building a prompt.
 */
export function primaryChatProvider(
  router: Router | null | undefined,
  fallback: LLMProvider,
): LLMProvider {
  if (router) {
    for (const name of router.getProviderOrder()) {
      const p = router.getProvider(name);
      if (p && p.isAvailable()) return p;
    }
  }
  return fallback;
}

/**
 * A system-prompt section stating the model the bot runs on. Empty string when
 * no provider is known (caller can concatenate unconditionally).
 */
export function modelIdentityPrompt(
  provider: Pick<LLMProvider, 'name' | 'model'> | undefined,
): string {
  if (!provider) return '';
  const label =
    provider.model && provider.model !== provider.name
      ? `\`${provider.model}\` (served via the \`${provider.name}\` provider)`
      : `\`${provider.name}\``;
  return (
    `\n\n## MODEL IDENTITY\n` +
    `You are running on the ${label} model on the user's own server. ` +
    `If the user asks which model or LLM you are, tell them this — ` +
    `do not guess or invent a model, system, or ecosystem name.`
  );
}
