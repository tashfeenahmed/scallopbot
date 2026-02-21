/**
 * Tests for Tool Policy Pipeline.
 */

import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from '../providers/types.js';
import {
  expandToolGroups,
  matchesPolicy,
  filterToolsByPolicy,
  applyToolPolicyPipeline,
  getToolProfile,
  TOOL_GROUPS,
  TOOL_PROFILES,
} from './tool-policy.js';

// Helper: create a minimal ToolDefinition
function tool(name: string): ToolDefinition {
  return {
    name,
    description: `Tool: ${name}`,
    input_schema: { type: 'object' as const, properties: {} },
  };
}

const ALL_TOOLS = [
  tool('read_file'),
  tool('write_file'),
  tool('edit_file'),
  tool('bash'),
  tool('web_search'),
  tool('memory_search'),
  tool('send_message'),
  tool('spawn_agent'),
  tool('question'),
  tool('webfetch'),
];

// ============ expandToolGroups ============

describe('expandToolGroups', () => {
  it('expands group:read to individual tools', () => {
    const expanded = expandToolGroups(['group:read']);
    expect(expanded).toEqual(TOOL_GROUPS['group:read']);
  });

  it('passes through non-group patterns', () => {
    const expanded = expandToolGroups(['bash', 'custom_tool']);
    expect(expanded).toEqual(['bash', 'custom_tool']);
  });

  it('mixes groups and individual tools', () => {
    const expanded = expandToolGroups(['group:exec', 'question']);
    expect(expanded).toContain('bash');
    expect(expanded).toContain('question');
  });
});

// ============ matchesPolicy ============

describe('matchesPolicy', () => {
  it('allows everything with empty policy', () => {
    expect(matchesPolicy('bash', {})).toBe(true);
  });

  it('denies tools in deny list', () => {
    expect(matchesPolicy('spawn_agent', { deny: ['spawn_agent'] })).toBe(false);
  });

  it('allows tools not in deny list', () => {
    expect(matchesPolicy('bash', { deny: ['spawn_agent'] })).toBe(true);
  });

  it('restricts to allow list when present', () => {
    const policy = { allow: ['read_file', 'question'] };
    expect(matchesPolicy('read_file', policy)).toBe(true);
    expect(matchesPolicy('bash', policy)).toBe(false);
  });

  it('supports group references in allow', () => {
    const policy = { allow: ['group:read'] };
    expect(matchesPolicy('read_file', policy)).toBe(true);
    expect(matchesPolicy('grep', policy)).toBe(true);
    expect(matchesPolicy('bash', policy)).toBe(false);
  });

  it('supports group references in deny', () => {
    const policy = { deny: ['group:agent'] };
    expect(matchesPolicy('spawn_agent', policy)).toBe(false);
    expect(matchesPolicy('bash', policy)).toBe(true);
  });

  it('deny takes priority over allow', () => {
    const policy = { allow: ['bash', 'spawn_agent'], deny: ['spawn_agent'] };
    expect(matchesPolicy('spawn_agent', policy)).toBe(false);
    expect(matchesPolicy('bash', policy)).toBe(true);
  });

  it('supports wildcard patterns', () => {
    const policy = { allow: ['web_*'] };
    expect(matchesPolicy('web_search', policy)).toBe(true);
    expect(matchesPolicy('webfetch', policy)).toBe(false); // no underscore after web
  });
});

// ============ filterToolsByPolicy ============

describe('filterToolsByPolicy', () => {
  it('returns all tools with empty policy', () => {
    const result = filterToolsByPolicy(ALL_TOOLS, {});
    expect(result.length).toBe(ALL_TOOLS.length);
  });

  it('removes denied tools', () => {
    const result = filterToolsByPolicy(ALL_TOOLS, { deny: ['spawn_agent', 'send_message'] });
    expect(result.map(t => t.name)).not.toContain('spawn_agent');
    expect(result.map(t => t.name)).not.toContain('send_message');
    expect(result.length).toBe(ALL_TOOLS.length - 2);
  });

  it('restricts to allowed tools', () => {
    const result = filterToolsByPolicy(ALL_TOOLS, { allow: ['group:read', 'question'] });
    const names = result.map(t => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('question');
    expect(names).not.toContain('bash');
    expect(names).not.toContain('spawn_agent');
  });
});

// ============ applyToolPolicyPipeline ============

describe('applyToolPolicyPipeline', () => {
  it('applies policies in order, each restricting further', () => {
    const result = applyToolPolicyPipeline(ALL_TOOLS, [
      { label: 'global', policy: { deny: ['spawn_agent'] } },
      { label: 'channel', policy: { deny: ['send_message'] } },
    ]);

    const names = result.map(t => t.name);
    expect(names).not.toContain('spawn_agent');
    expect(names).not.toContain('send_message');
    expect(names).toContain('bash');
  });

  it('skips stages with no policy', () => {
    const result = applyToolPolicyPipeline(ALL_TOOLS, [
      { label: 'global' }, // no policy
      { label: 'channel', policy: { deny: ['spawn_agent'] } },
    ]);

    expect(result.length).toBe(ALL_TOOLS.length - 1);
  });

  it('cumulative restriction with allow + deny', () => {
    const result = applyToolPolicyPipeline(ALL_TOOLS, [
      { label: 'global', policy: { deny: ['spawn_agent'] } },
      { label: 'subagent', policy: { allow: ['group:read', 'group:web', 'question'] } },
    ]);

    const names = result.map(t => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('web_search');
    expect(names).toContain('question');
    expect(names).not.toContain('bash');
    expect(names).not.toContain('spawn_agent');
  });
});

// ============ TOOL_PROFILES ============

describe('TOOL_PROFILES', () => {
  it('full profile has no restrictions', () => {
    expect(TOOL_PROFILES.full).toEqual({});
  });

  it('standard profile denies spawn_agent', () => {
    const result = filterToolsByPolicy(ALL_TOOLS, TOOL_PROFILES.standard);
    expect(result.map(t => t.name)).not.toContain('spawn_agent');
    expect(result.length).toBe(ALL_TOOLS.length - 1);
  });

  it('readonly profile allows only read/web/memory/question', () => {
    const result = filterToolsByPolicy(ALL_TOOLS, TOOL_PROFILES.readonly);
    const names = result.map(t => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('web_search');
    expect(names).toContain('memory_search');
    expect(names).toContain('question');
    expect(names).not.toContain('bash');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('spawn_agent');
  });

  it('minimal profile allows only question', () => {
    const result = filterToolsByPolicy(ALL_TOOLS, TOOL_PROFILES.minimal);
    expect(result.map(t => t.name)).toEqual(['question']);
  });
});

// ============ getToolProfile ============

describe('getToolProfile', () => {
  it('returns known profiles', () => {
    expect(getToolProfile('full')).toBeDefined();
    expect(getToolProfile('readonly')).toBeDefined();
  });

  it('returns undefined for unknown profiles', () => {
    expect(getToolProfile('nonexistent')).toBeUndefined();
  });
});
