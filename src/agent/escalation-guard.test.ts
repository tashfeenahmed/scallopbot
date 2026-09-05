import { describe, expect, it } from 'vitest';
import { blockedTargetFromToolCall, findBlockedEscalation } from './escalation-guard.js';

const notionCreate = {
  type: 'tool_use' as const,
  id: 'n1',
  name: 'notion',
  input: { action: 'create', database_id: '1801c5f6-386c-927e-228b-2a0b29321df0', properties: { Name: 'Leg press' } },
};

describe('escalation guard', () => {
  it('describes a blocked typed-skill call by name token and ids', () => {
    const target = blockedTargetFromToolCall(notionCreate);
    expect(target.tokens).toContain('notion');
    expect(target.ids).toContain('1801c5f6-386c-927e-228b-2a0b29321df0');
  });

  it('blocks bash curl, python requests, write_file, workflow, sub-agent and goal detours to the same target', () => {
    const targets = [blockedTargetFromToolCall(notionCreate)];
    const detours = [
      { name: 'bash', input: { command: "curl -s -X POST https://api.notion.com/v1/pages -d '{}'" } },
      { name: 'run_code', input: { language: 'python', code: "import requests\nrequests.post('https://api.notion.com/v1/pages')" } },
      { name: 'bash', input: { command: 'wget --post-data x https://api.notion.com/v1/databases/1801c5f6-386c-927e-228b-2a0b29321df0/query' } },
      { name: 'write_file', input: { path: '/tmp/notion-log.json', content: 'x' } },
      { name: 'execute_workflow', input: { steps: [{ tool: 'notion', action: 'create' }] } },
      { name: 'spawn_agent', input: { task: 'Log the workout to Notion for me' } },
      { name: 'execute_goal', input: { goal: 'Add the pectoral machine sets to the Notion gym tracker' } },
    ];
    for (const detour of detours) {
      expect(findBlockedEscalation({ type: 'tool_use', id: 'x', ...detour }, targets), detour.name).not.toBeNull();
    }
  });

  it('does not block unrelated tool calls or read-only tools', () => {
    const targets = [blockedTargetFromToolCall(notionCreate)];
    expect(findBlockedEscalation({ type: 'tool_use', id: 'x', name: 'bash', input: { command: 'ls -la' } }, targets)).toBeNull();
    expect(findBlockedEscalation({ type: 'tool_use', id: 'x', name: 'web_search', input: { query: 'notion api' } }, targets)).toBeNull();
    expect(findBlockedEscalation({ type: 'tool_use', id: 'x', name: 'notion', input: { action: 'search' } }, targets)).toBeNull();
  });

  it('tracks a blocked bash curl by host so a rephrased curl to the same host is a detour', () => {
    const blocked = blockedTargetFromToolCall({
      type: 'tool_use', id: 'b1', name: 'bash',
      input: { command: 'curl -X POST https://api.stripe.com/v1/refunds -d amount=100' },
    });
    expect(blocked.tokens).toEqual([]);
    expect(blocked.hosts).toContain('api.stripe.com');
    expect(findBlockedEscalation({
      type: 'tool_use', id: 'b2', name: 'run_code',
      input: { language: 'python', code: "requests.post('https://api.stripe.com/v1/refunds')" },
    }, [blocked])).not.toBeNull();
    expect(findBlockedEscalation({
      type: 'tool_use', id: 'b3', name: 'bash', input: { command: 'curl https://example.com' },
    }, [blocked])).toBeNull();
  });
});
