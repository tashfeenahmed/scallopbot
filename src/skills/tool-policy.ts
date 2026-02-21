/**
 * Tool Policy Pipeline
 *
 * Provides per-channel, per-provider, and per-sub-agent tool filtering
 * using allow/deny glob patterns and named tool groups.
 */

import type { ToolDefinition } from '../providers/types.js';

export interface ToolPolicy {
  /** Glob patterns — if set, only matching tools pass */
  allow?: string[];
  /** Glob patterns — always removed */
  deny?: string[];
}

/**
 * Named tool groups for convenience.
 * Patterns starting with "group:" are expanded to their member tools.
 */
export const TOOL_GROUPS: Record<string, string[]> = {
  'group:read':     ['read_file', 'ls', 'glob', 'grep', 'codesearch'],
  'group:write':    ['write_file', 'edit_file', 'multi_edit'],
  'group:exec':     ['bash'],
  'group:web':      ['web_search', 'webfetch'],
  'group:memory':   ['memory_search'],
  'group:comms':    ['send_message', 'send_file', 'question'],
  'group:agent':    ['spawn_agent'],
};

/**
 * Pre-built profiles for common restriction patterns.
 */
export const TOOL_PROFILES: Record<string, ToolPolicy> = {
  /** No restrictions */
  full:       {},
  /** No sub-agents */
  standard:   { deny: ['spawn_agent'] },
  /** Read-only: can search, read, and ask questions but not modify anything */
  readonly:   { allow: ['group:read', 'group:web', 'group:memory', 'question'] },
  /** Minimal: can only ask questions */
  minimal:    { allow: ['question'] },
};

/**
 * Expand group references in a list of patterns.
 * e.g., ['group:read', 'bash'] → ['read_file', 'ls', 'glob', 'grep', 'codesearch', 'bash']
 */
export function expandToolGroups(patterns: string[]): string[] {
  const expanded: string[] = [];
  for (const pattern of patterns) {
    const group = TOOL_GROUPS[pattern];
    if (group) {
      expanded.push(...group);
    } else {
      expanded.push(pattern);
    }
  }
  return expanded;
}

/**
 * Simple glob matching supporting * wildcard.
 * e.g., "web_*" matches "web_search", "web_fetch"
 */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes('*')) return false;

  // Convert glob pattern to regex
  const regexStr = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
  return new RegExp(regexStr).test(value);
}

/**
 * Check if a tool name matches any pattern in a list (with group expansion).
 */
function matchesAnyPattern(toolName: string, patterns: string[]): boolean {
  const expanded = expandToolGroups(patterns);
  return expanded.some(pattern => globMatch(pattern, toolName));
}

/**
 * Check if a tool is allowed by a policy.
 */
export function matchesPolicy(toolName: string, policy: ToolPolicy): boolean {
  // If deny list exists and tool matches, reject
  if (policy.deny && matchesAnyPattern(toolName, policy.deny)) {
    return false;
  }

  // If allow list exists, tool must match at least one pattern
  if (policy.allow && policy.allow.length > 0) {
    return matchesAnyPattern(toolName, policy.allow);
  }

  // No restrictions → allowed
  return true;
}

/**
 * Filter a list of tool definitions by a single policy.
 */
export function filterToolsByPolicy(
  tools: ToolDefinition[],
  policy: ToolPolicy
): ToolDefinition[] {
  return tools.filter(tool => matchesPolicy(tool.name, policy));
}

export interface LabeledPolicy {
  policy?: ToolPolicy;
  label: string;
}

/**
 * Apply a pipeline of policies in order.
 * Each stage further restricts the available tools.
 * Stages with no policy are skipped.
 *
 * @returns Filtered tool definitions
 */
export function applyToolPolicyPipeline(
  tools: ToolDefinition[],
  policies: LabeledPolicy[]
): ToolDefinition[] {
  let filtered = tools;
  for (const { policy } of policies) {
    if (policy) {
      filtered = filterToolsByPolicy(filtered, policy);
    }
  }
  return filtered;
}

/**
 * Get a named profile's policy. Returns undefined for unknown profiles.
 */
export function getToolProfile(name: string): ToolPolicy | undefined {
  return TOOL_PROFILES[name];
}
