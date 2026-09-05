/**
 * Policy-block escalation guard.
 *
 * When the current-turn intent gate blocks a write (SAFETY_*_INTENT_REQUIRED),
 * small models try to reach the same target through another door: bash curl,
 * a python `requests.post`, write_file, a workflow, a sub-agent, or a goal.
 * The same policy applies to every tool, so the agent records the blocked
 * target and short-circuits those detours with a single deterministic error
 * that tells the model what to do instead (ask the one-line question).
 */

import type { ToolUseContent } from '../providers/types.js';

export interface BlockedTarget {
  tool: string;
  /** Hostnames found in the blocked call's input. */
  hosts: string[];
  /** Identifier-like values (database ids, page ids, paths) from the input. */
  ids: string[];
  /** Name tokens of the blocked integration (empty for generic executors). */
  tokens: string[];
}

export const BLOCKED_ESCALATION_MESSAGE =
  'BLOCKED_ESCALATION: the same policy applies to every tool. Ask the user the one-line confirmation question instead.';

/** Tools that can act as a detour to an already-blocked target. */
const ESCALATION_TOOLS = /^(?:bash|run_code|write_file|edit_file|execute_workflow|spawn_agent|execute_goal)$/i;

/** Executors whose name says nothing about the target. */
const GENERIC_TOOLS = new Set([
  'bash', 'run_code', 'write_file', 'edit_file', 'execute_workflow', 'spawn_agent',
  'execute_goal', 'send_message', 'read_file', 'ls', 'grep', 'glob', 'webfetch',
  'web_search', 'question',
]);

const URL_HOST = /https?:\/\/([a-z0-9.-]+)/gi;
const BARE_HOST = /\b((?:[a-z0-9-]+\.)+(?:com|io|co|net|org|dev|ai|app|so|me|uk|eu|sh|xyz))\b/gi;
const ID_KEY = /(?:^|_)(?:id|ids|database|data_source|datasource|page|parent|path|file|channel|repo|repository|sheet|doc|document|calendar|board|url|endpoint|table|collection)$/i;

function collectIds(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === 'string') {
      const trimmed = child.trim();
      if (ID_KEY.test(key) && trimmed.length >= 6 && trimmed.length <= 300) out.add(trimmed.toLowerCase());
    } else {
      collectIds(child, out, depth + 1);
    }
  }
}

function collectHosts(serialized: string, out: Set<string>): void {
  for (const match of serialized.matchAll(URL_HOST)) out.add(match[1].toLowerCase());
  for (const match of serialized.matchAll(BARE_HOST)) out.add(match[1].toLowerCase());
}

/** Describe the target of a call that was just blocked by the intent gate. */
export function blockedTargetFromToolCall(toolUse: ToolUseContent): BlockedTarget {
  const serialized = JSON.stringify(toolUse.input ?? {});
  const hosts = new Set<string>();
  collectHosts(serialized, hosts);
  const ids = new Set<string>();
  collectIds(toolUse.input, ids);
  const name = toolUse.name.toLowerCase();
  const tokens: string[] = [];
  if (!GENERIC_TOOLS.has(name)) {
    tokens.push(name);
    const base = name.replace(/[_-]?(?:api|tool|skill|write|create|client)$/i, '');
    if (base && base !== name && base.length >= 3) tokens.push(base);
  }
  return { tool: toolUse.name, hosts: [...hosts], ids: [...ids], tokens };
}

/**
 * Return the blocked target this call is trying to reach through another
 * tool, or null when the call is unrelated to every blocked target.
 */
export function findBlockedEscalation(
  toolUse: ToolUseContent,
  targets: readonly BlockedTarget[],
): BlockedTarget | null {
  if (targets.length === 0 || !ESCALATION_TOOLS.test(toolUse.name)) return null;
  const serialized = JSON.stringify(toolUse.input ?? {}).toLowerCase();
  for (const target of targets) {
    if (target.hosts.some(host => serialized.includes(host))) return target;
    if (target.ids.some(id => serialized.includes(id))) return target;
    if (target.tokens.some(token => new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(token)}(?![a-z0-9])`, 'i').test(serialized))) {
      return target;
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
