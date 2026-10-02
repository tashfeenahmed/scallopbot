/**
 * Fan-in through files: every child's final report is written to
 *   <workspace>/.scallopbot/agents/<parent session>/<name>.md
 * The parent's read_file reaches it (it lives in the parent's workspace, not
 * a child worktree), and the injected [agent-result] message is capped — the
 * file always holds the full text.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SubAgentResult, SubAgentRun } from './types.js';

export const AGENTS_DIR = path.join('.scallopbot', 'agents');

function safeSegment(value: string, fallback: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

export function agentReportDir(workspace: string, parentSessionId: string): string {
  return path.join(workspace, AGENTS_DIR, safeSegment(parentSessionId, 'session'));
}

export function agentReportPath(workspace: string, parentSessionId: string, name: string): string {
  return path.join(agentReportDir(workspace, parentSessionId), `${safeSegment(name, 'agent')}.md`);
}

function section(title: string, items: readonly string[]): string[] {
  return items.length ? ['', `## ${title}`, ...items.map(item => `- ${item}`)] : [];
}

/** Markdown body for the report file and the parent message. */
export function renderAgentReport(
  run: Pick<SubAgentRun, 'label' | 'task'>,
  result: SubAgentResult,
  fullText?: string,
): string {
  const body = (fullText ?? result.summary).trim();
  const lines = [
    `status: ${result.status} · iterations: ${result.iterationsUsed} · cost: $${result.costUsd.toFixed(4)}`,
    '',
    body || '(empty report)',
    ...section('Changed files', result.changedFiles),
    ...section('Tests', result.tests),
    ...section('Artifacts', result.artifacts.map(a => `${a.type}: ${a.value}`)),
    ...section('Blockers', result.blockers),
    ...section('Next actions', result.nextActions),
  ];
  return lines.join('\n');
}

/** Write the report; returns the absolute path. Never throws (returns undefined on failure). */
export async function writeAgentReport(
  workspace: string,
  parentSessionId: string,
  name: string,
  content: string,
  task?: string,
): Promise<string | undefined> {
  try {
    const dir = agentReportDir(workspace, parentSessionId);
    await fs.mkdir(dir, { recursive: true });
    // Keep reports out of `git status` when the workspace is a repository.
    const ignore = path.join(workspace, AGENTS_DIR, '.gitignore');
    await fs.writeFile(ignore, '*\n', { flag: 'wx' }).catch(() => undefined);
    const file = agentReportPath(workspace, parentSessionId, name);
    const header = [`# ${name}`, ...(task ? ['', `Task: ${task.trim().slice(0, 2_000)}`] : []), ''];
    await fs.writeFile(file, `${header.join('\n')}\n${content.trim()}\n`, 'utf8');
    return file;
  } catch {
    return undefined;
  }
}
