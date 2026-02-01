/**
 * Session Branching
 * Sub-conversations for investigation with summarize & merge
 */

import { nanoid } from 'nanoid';
import type { Message } from '../providers/types.js';
import type { Logger } from 'pino';

export type BranchState = 'active' | 'merged' | 'discarded';

export interface BranchOptions {
  parentSessionId: string;
  name: string;
  metadata?: Record<string, unknown>;
}

/**
 * A branch represents a sub-conversation for investigation
 */
export class Branch {
  readonly id: string;
  readonly parentSessionId: string;
  readonly name: string;
  readonly metadata?: Record<string, unknown>;
  private _messages: Message[] = [];
  private _state: BranchState = 'active';
  private _createdAt: Date;

  constructor(options: BranchOptions) {
    this.id = nanoid();
    this.parentSessionId = options.parentSessionId;
    this.name = options.name;
    this.metadata = options.metadata;
    this._createdAt = new Date();
  }

  get messages(): Message[] {
    return [...this._messages];
  }

  get messageCount(): number {
    return this._messages.length;
  }

  get state(): BranchState {
    return this._state;
  }

  get createdAt(): Date {
    return this._createdAt;
  }

  addMessage(message: Message): void {
    if (this._state !== 'active') {
      throw new Error(`Cannot add message to ${this._state} branch`);
    }
    this._messages.push(message);
  }

  setState(state: BranchState): void {
    this._state = state;
  }

  setMessages(messages: Message[]): void {
    if (this._state !== 'active') {
      throw new Error(`Cannot set messages on ${this._state} branch`);
    }
    this._messages = [...messages];
  }
}

export interface MergeResult {
  success: boolean;
  summary: string;
  error?: string;
}

export interface BranchManagerOptions {
  logger: Logger;
}

/**
 * Manages branches for sessions
 */
export class BranchManager {
  private branches: Map<string, Branch> = new Map();
  private sessionIndex: Map<string, Set<string>> = new Map();
  private logger: Logger;

  constructor(options: BranchManagerOptions) {
    this.logger = options.logger.child({ component: 'branch-manager' });
  }

  createBranch(
    sessionId: string,
    name: string,
    contextMessages?: Message[]
  ): Branch {
    const branch = new Branch({
      parentSessionId: sessionId,
      name,
    });

    // Copy context messages if provided
    if (contextMessages && contextMessages.length > 0) {
      branch.setMessages(contextMessages);
    }

    this.branches.set(branch.id, branch);

    // Add to session index
    let sessionBranches = this.sessionIndex.get(sessionId);
    if (!sessionBranches) {
      sessionBranches = new Set();
      this.sessionIndex.set(sessionId, sessionBranches);
    }
    sessionBranches.add(branch.id);

    this.logger.info(
      { branchId: branch.id, sessionId, name },
      'Created branch'
    );

    return branch;
  }

  getBranch(branchId: string): Branch | undefined {
    return this.branches.get(branchId);
  }

  getBranchesForSession(sessionId: string): Branch[] {
    const branchIds = this.sessionIndex.get(sessionId);
    if (!branchIds) {
      return [];
    }

    return Array.from(branchIds)
      .map((id) => this.branches.get(id))
      .filter((b): b is Branch => b !== undefined);
  }

  getActiveBranches(sessionId: string): Branch[] {
    return this.getBranchesForSession(sessionId).filter(
      (b) => b.state === 'active'
    );
  }

  async mergeBranch(branchId: string): Promise<MergeResult> {
    const branch = this.branches.get(branchId);

    if (!branch) {
      return {
        success: false,
        summary: '',
        error: 'Branch not found',
      };
    }

    if (branch.state !== 'active') {
      return {
        success: false,
        summary: '',
        error: `Branch is already ${branch.state}`,
      };
    }

    // Generate summary
    const summary = summarizeBranch(branch.messages, branch.name);

    // Mark as merged
    branch.setState('merged');

    this.logger.info(
      { branchId, sessionId: branch.parentSessionId },
      'Merged branch'
    );

    return {
      success: true,
      summary,
    };
  }

  discardBranch(branchId: string): boolean {
    const branch = this.branches.get(branchId);

    if (!branch) {
      return false;
    }

    branch.setState('discarded');

    this.logger.info(
      { branchId, sessionId: branch.parentSessionId },
      'Discarded branch'
    );

    return true;
  }

  cleanup(maxAgeMs: number): number {
    const now = Date.now();
    let removed = 0;

    for (const [branchId, branch] of this.branches) {
      if (branch.state === 'discarded') {
        const age = now - branch.createdAt.getTime();
        if (age > maxAgeMs) {
          // Remove from session index
          const sessionBranches = this.sessionIndex.get(branch.parentSessionId);
          if (sessionBranches) {
            sessionBranches.delete(branchId);
          }

          // Remove branch
          this.branches.delete(branchId);
          removed++;
        }
      }
    }

    if (removed > 0) {
      this.logger.debug({ removed }, 'Cleaned up discarded branches');
    }

    return removed;
  }
}

/**
 * Summarize branch messages into a compact form
 */
export function summarizeBranch(messages: Message[], branchName: string): string {
  if (messages.length === 0) {
    return '';
  }

  // Extract key content from assistant messages
  const findings: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content) {
        // Extract key sentences (those with important keywords)
        const sentences = content.split(/[.!?]+/).filter((s) => s.trim());
        for (const sentence of sentences) {
          const lower = sentence.toLowerCase();
          if (
            lower.includes('found') ||
            lower.includes('error') ||
            lower.includes('issue') ||
            lower.includes('bug') ||
            lower.includes('problem') ||
            lower.includes('solution') ||
            lower.includes('fixed') ||
            lower.includes('caused') ||
            lower.includes('because')
          ) {
            findings.push(sentence.trim());
          }
        }
      }
    }
  }

  if (findings.length === 0) {
    // Fall back to last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        const content =
          typeof messages[i].content === 'string' ? messages[i].content : '';
        if (content) {
          return `${branchName}: ${content.substring(0, 200)}...`;
        }
      }
    }
    return '';
  }

  // Combine findings
  const uniqueFindings = [...new Set(findings)];
  const summary = uniqueFindings.slice(0, 3).join('. ');

  return `${branchName}: ${summary}`;
}

/**
 * Merge multiple branch summaries
 */
export function mergeBranches(summaries: string[]): string {
  if (summaries.length === 0) {
    return '';
  }

  if (summaries.length === 1) {
    return summaries[0];
  }

  return summaries.join('\n\n');
}
