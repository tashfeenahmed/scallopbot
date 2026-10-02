/**
 * Learning runtime: one object the gateway builds and the agent calls.
 *
 *   core          CoreMemoryStore (frozen per session via renderSessionCoreMemory)
 *   skillAuthor   verified + versioned skill create/patch (skill_manage tool)
 *   curator       nightly archive of unused agent-created skills
 *   reviewer      background learning fork (after the reply)
 *   refine        Prime-style refine pass (after the reply)
 *
 * The agent supplies the session replay (frozen system prompt + messages) with
 * setReplaySource(); until then reviews replay persisted text messages.
 */

import type { Logger } from 'pino';
import type { LLMProvider, Message, SystemPrompt, ToolDefinition } from '../providers/types.js';
import type { ScallopDatabase } from '../memory/db.js';
import type { Skill } from '../skills/types.js';
import { SkillStore } from '../evolution/skill-store.js';
import { judgeMutation } from '../evolution/judge.js';
import {
  CoreMemoryStore,
  registerCoreMemoryTool,
  seedCoreMemory,
  seedSourceFromStore,
} from '../memory/core-memory.js';
import type { ScallopMemoryStore } from '../memory/scallop-store.js';
import { SkillAuthor, createSkillManageSkill, SKILL_MANAGE_TOOL_NAME } from './skill-author.js';
import { SkillCurator } from './curator.js';
import {
  BackgroundReviewer,
  createReviewReadFileTool,
  reviewToolFromSkill,
  reviewToolsFromRegistry,
  type ReviewReplay,
  type ReviewTool,
} from './background-review.js';
import { RefinePass, buildRefineTranscript, renderPromptNotes } from './refine.js';
import { buildSkillIndex } from '../skills/skill-index.js';

export * from './background-review.js';
export * from './refine.js';
export * from './skill-author.js';
export * from './curator.js';

export interface LearningRegistry {
  hasSkill(name: string): boolean;
  getSkill(name: string): Skill | undefined;
  registerSkill(skill: Skill): void;
  reloadFromDisk(): Promise<void>;
  getDocumentationSkills(): Skill[];
  getExecutableSkills(): Skill[];
}

export interface LearningRuntimeOptions {
  db: ScallopDatabase;
  scallopStore?: ScallopMemoryStore;
  registry: LearningRegistry;
  workspace: string;
  /** Local skills dir (~/.scallopbot/skills by default). */
  localSkillsDir?: string;
  canonicalSingleUserIds?: readonly string[];
  /** Provider for reviews (main model → cache hit on the replayed session). */
  getReviewProvider: () => LLMProvider | undefined | Promise<LLMProvider | undefined>;
  /** Cheap provider for the refine yes/no review (fast tier). */
  getCheapProvider?: () => LLMProvider | undefined | Promise<LLMProvider | undefined>;
  /** When set, every skill write also passes the fail-closed LLM safety judge. */
  getJudgeProvider?: () => LLMProvider | undefined | Promise<LLMProvider | undefined>;
  curator?: {
    enabled?: boolean;
    staleAfterDays?: number;
    archiveAfterDays?: number;
    backupKeep?: number;
  };
  /** Use an existing SkillStore (e.g. the evolution engine's) to share one usage queue. */
  skillStore?: SkillStore;
  logger?: Logger;
}

export type ReplaySource = (sessionId: string, userId: string) => ReviewReplay | null | Promise<ReviewReplay | null>;

/** Persisted session rows → alternating text-only messages (fallback replay). */
export function replayFromSessionRows(rows: Array<{ role: string; content: string }>): Message[] {
  const messages: Message[] = [];
  for (const row of rows) {
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    let text = row.content;
    try {
      const parsed = JSON.parse(row.content) as unknown;
      if (Array.isArray(parsed)) {
        text = parsed
          .map(block => (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block
            ? String(block.text)
            : ''))
          .filter(Boolean)
          .join('\n');
      } else if (typeof parsed === 'string') {
        text = parsed;
      }
    } catch {
      // plain text
    }
    text = text.trim();
    if (!text) continue;
    const role = row.role;
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content = `${last.content as string}\n\n${text}`;
    } else {
      messages.push({ role, content: text });
    }
  }
  while (messages.length > 0 && messages[0].role !== 'user') messages.shift();
  return messages;
}

export class LearningRuntime {
  readonly core: CoreMemoryStore;
  readonly skillAuthor: SkillAuthor;
  readonly curator: SkillCurator;
  readonly reviewer: BackgroundReviewer;
  readonly refine: RefinePass;
  private replaySource: ReplaySource | null = null;

  constructor(private readonly options: LearningRuntimeOptions) {
    const { db, registry } = options;
    this.core = new CoreMemoryStore(db);
    const store = options.skillStore ?? new SkillStore({ localDir: options.localSkillsDir, logger: options.logger });
    this.curator = new SkillCurator({
      store,
      reloadFromDisk: () => registry.reloadFromDisk(),
      runtimeKeys: db,
      logger: options.logger,
      ...options.curator,
    });
    this.skillAuthor = new SkillAuthor({
      store,
      db,
      reloadFromDisk: () => registry.reloadFromDisk(),
      resolveTarget: name => {
        const skill = registry.getSkill(name);
        return skill
          ? { exists: true, source: skill.source, hasScripts: skill.hasScripts, content: skill.content }
          : { exists: false };
      },
      judge: options.getJudgeProvider
        ? async description => judgeMutation(description, await options.getJudgeProvider!())
        : undefined,
      source: 'learning',
      logger: options.logger,
    });
    this.reviewer = new BackgroundReviewer({
      getProvider: () => options.getReviewProvider(),
      getReplay: (sessionId, userId) => this.getReplay(sessionId, userId),
      getTools: () => this.reviewTools(),
      logger: options.logger,
    });
    this.refine = new RefinePass({
      db,
      core: this.core,
      skillAuthor: this.skillAuthor,
      getReviewProvider: () => (options.getCheapProvider ?? options.getReviewProvider)(),
      getRefineProvider: () => options.getReviewProvider(),
      getContext: sessionId => ({
        transcript: buildRefineTranscript(db.getSessionMessages(sessionId)),
        skills: buildSkillIndex(registry),
      }),
      logger: options.logger,
    });
  }

  /** Register `memory` (core memory) and `skill_manage` in the main registry. Call once. */
  registerTools(): { coreMemory: Skill; skillManage: Skill } {
    const coreMemory = registerCoreMemoryTool(this.options.registry, {
      core: this.core,
      canonicalSingleUserIds: this.options.canonicalSingleUserIds,
    });
    const skillManage = createSkillManageSkill(this.skillAuthor);
    this.options.registry.registerSkill(skillManage);
    return { coreMemory, skillManage };
  }

  /** Agent hook: supply the frozen session prompt + messages for review replays. */
  setReplaySource(source: ReplaySource | null): void {
    this.replaySource = source;
  }

  private async getReplay(sessionId: string, userId: string): Promise<ReviewReplay | null> {
    if (this.replaySource) {
      const replay = await this.replaySource(sessionId, userId);
      if (replay) return replay;
    }
    const messages = replayFromSessionRows(this.options.db.getSessionMessages(sessionId));
    if (messages.length === 0) return null;
    return { system: 'You are ScallopBot, a personal AI agent. The transcript below is a past session.', messages };
  }

  /** Tools the review fork may use (only these). */
  reviewTools(): ReviewTool[] {
    const base = { workspace: this.options.workspace };
    const names = [
      this.options.registry.hasSkill('memory') ? 'memory' : 'core_memory',
      'load_procedure',
      'session_search',
    ];
    const tools = reviewToolsFromRegistry(this.options.registry, names, base);
    const skillManage = this.options.registry.getSkill(SKILL_MANAGE_TOOL_NAME)
      ?? createSkillManageSkill(this.skillAuthor);
    const skillTool = reviewToolFromSkill(skillManage, base);
    if (skillTool) tools.push(skillTool);
    tools.push(createReviewReadFileTool({
      roots: [this.options.workspace, ...(this.options.localSkillsDir ? [this.options.localSkillsDir] : [])],
    }));
    return tools;
  }

  /**
   * Session-start helper: seed core memory once (if never written), then
   * return the block text to freeze into the session prompt.
   */
  renderSessionCoreMemory(userId: string): string {
    if (this.options.scallopStore) {
      try {
        seedCoreMemory(this.core, seedSourceFromStore(this.options.scallopStore), userId);
      } catch (error) {
        this.options.logger?.debug({ error: (error as Error).message }, 'Core memory seed failed (non-fatal)');
      }
    }
    return this.core.render(userId);
  }

  /** Learned refine notes, to freeze into the session prompt. */
  renderPromptNotes(): string {
    return renderPromptNotes(this.options.db);
  }

  /** Skills index for the frozen session prompt (replaces generateSkillPrompt()). */
  renderSkillIndex(): string {
    return buildSkillIndex(this.options.registry);
  }

  /** Session tool definitions helper for cache-preserving replays. */
  static replay(system: string | SystemPrompt, messages: Message[], tools?: ToolDefinition[]): ReviewReplay {
    return { system, messages, tools };
  }
}
