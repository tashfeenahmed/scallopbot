/**
 * ScallopBot Skill SDK
 *
 * Native programmatic skill definition API.
 * Provides a fluent builder interface for creating skills without YAML/Markdown.
 *
 * Example:
 * ```typescript
 * import { defineSkill } from 'scallopbot';
 *
 * const mySkill = defineSkill('my-skill', 'Does something useful')
 *   .userInvocable()
 *   .requiresBins('git', 'npm')
 *   .requiresEnv('GITHUB_TOKEN')
 *   .onExecute(async (context) => {
 *     // Skill logic here
 *     return { success: true, output: 'Done!' };
 *   })
 *   .build();
 * ```
 */

import type { Logger } from 'pino';
import type {
  Skill,
  SkillFrontmatter,
  SkillMetadata,
  SkillContext,
  SkillResult,
} from './types.js';
import { checkGates } from './loader.js';

/**
 * Skill handler function type
 */
export type SkillHandler = (context: SkillExecutionContext) => Promise<SkillResult>;

/**
 * Extended execution context with utilities
 */
export interface SkillExecutionContext extends SkillContext {
  /** Skill name */
  skillName: string;
  /** Logger instance */
  logger: Logger;
  /** Parse arguments as key-value pairs */
  parseArgs(): Record<string, string>;
  /** Parse arguments as positional array */
  parseArgsPositional(): string[];
}

/**
 * Skill definition created by defineSkill()
 */
export interface SkillDefinition {
  /** Skill metadata */
  skill: Skill;
  /** Execution handler */
  handler?: SkillHandler;
  /** Execute the skill */
  execute(context: Omit<SkillExecutionContext, 'skillName' | 'logger' | 'parseArgs' | 'parseArgsPositional'>, logger: Logger): Promise<SkillResult>;
}

/**
 * Skill builder options
 */
export interface SkillBuilderOptions {
  /** Command dispatch bypasses model */
  commandDispatch?: boolean;
  /** Tool to invoke for command dispatch */
  commandTool?: string;
  /** Argument mode for command dispatch */
  commandArgMode?: 'raw' | 'parsed';
  /** User invocable as slash command */
  userInvocable?: boolean;
  /** Disable model invocation */
  disableModelInvocation?: boolean;
  /** Required binaries */
  requiredBins?: string[];
  /** Required any-of binaries */
  requiredAnyBins?: string[];
  /** Required environment variables */
  requiredEnv?: string[];
  /** Required config paths */
  requiredConfig?: string[];
  /** OS restriction */
  os?: string | string[];
  /** Primary environment variable */
  primaryEnv?: string;
  /** Emoji icon */
  emoji?: string;
  /** Homepage URL */
  homepage?: string;
  /** Instruction content for model */
  instructions?: string;
}

/**
 * Skill builder for fluent API
 */
export class SkillBuilder {
  private name: string;
  private description: string;
  private options: SkillBuilderOptions = {
    userInvocable: true,
    disableModelInvocation: false,
  };
  private handler?: SkillHandler;

  constructor(name: string, description: string) {
    this.name = name;
    this.description = description;
  }

  /**
   * Make skill available as a slash command
   */
  userInvocable(value: boolean = true): this {
    this.options.userInvocable = value;
    return this;
  }

  /**
   * Hide skill from model prompts
   */
  disableModelInvocation(value: boolean = true): this {
    this.options.disableModelInvocation = value;
    return this;
  }

  /**
   * Enable command dispatch (bypasses model, invokes tool directly)
   */
  commandDispatch(tool: string, argMode: 'raw' | 'parsed' = 'raw'): this {
    this.options.commandDispatch = true;
    this.options.commandTool = tool;
    this.options.commandArgMode = argMode;
    return this;
  }

  /**
   * Require specific binaries on PATH
   */
  requiresBins(...bins: string[]): this {
    this.options.requiredBins = bins;
    return this;
  }

  /**
   * Require at least one of these binaries on PATH
   */
  requiresAnyBins(...bins: string[]): this {
    this.options.requiredAnyBins = bins;
    return this;
  }

  /**
   * Require specific environment variables
   */
  requiresEnv(...envVars: string[]): this {
    this.options.requiredEnv = envVars;
    return this;
  }

  /**
   * Require specific config file paths
   */
  requiresConfig(...paths: string[]): this {
    this.options.requiredConfig = paths;
    return this;
  }

  /**
   * Restrict to specific operating system(s)
   */
  forOS(...os: string[]): this {
    this.options.os = os.length === 1 ? os[0] : os;
    return this;
  }

  /**
   * Set primary environment variable (for API key hints)
   */
  primaryEnv(env: string): this {
    this.options.primaryEnv = env;
    return this;
  }

  /**
   * Set emoji icon for UI
   */
  emoji(icon: string): this {
    this.options.emoji = icon;
    return this;
  }

  /**
   * Set homepage URL
   */
  homepage(url: string): this {
    this.options.homepage = url;
    return this;
  }

  /**
   * Set instructions for the model (markdown content)
   */
  instructions(content: string): this {
    this.options.instructions = content;
    return this;
  }

  /**
   * Set execution handler
   */
  onExecute(handler: SkillHandler): this {
    this.handler = handler;
    return this;
  }

  /**
   * Build the skill definition
   */
  build(): SkillDefinition {
    // Build frontmatter
    const frontmatter: SkillFrontmatter = {
      name: this.name,
      description: this.description,
      homepage: this.options.homepage,
      'user-invocable': this.options.userInvocable,
      'disable-model-invocation': this.options.disableModelInvocation,
    };

    if (this.options.commandDispatch) {
      frontmatter['command-dispatch'] = 'tool';
      frontmatter['command-tool'] = this.options.commandTool;
      if (this.options.commandArgMode === 'raw') {
        frontmatter['command-arg-mode'] = 'raw';
      }
    }

    // Build metadata
    const metadata: SkillMetadata = {};
    if (
      this.options.emoji ||
      this.options.os ||
      this.options.primaryEnv ||
      this.options.requiredBins?.length ||
      this.options.requiredAnyBins?.length ||
      this.options.requiredEnv?.length ||
      this.options.requiredConfig?.length
    ) {
      metadata.openclaw = {
        emoji: this.options.emoji,
        os: this.options.os,
        primaryEnv: this.options.primaryEnv,
      };

      if (
        this.options.requiredBins?.length ||
        this.options.requiredAnyBins?.length ||
        this.options.requiredEnv?.length ||
        this.options.requiredConfig?.length
      ) {
        metadata.openclaw.requires = {
          bins: this.options.requiredBins,
          anyBins: this.options.requiredAnyBins,
          env: this.options.requiredEnv,
          config: this.options.requiredConfig,
        };
      }

      frontmatter.metadata = metadata;
    }

    // Check gates
    const gateResult = checkGates(metadata);

    // Build skill
    const skill: Skill = {
      name: this.name,
      description: this.description,
      path: `sdk:${this.name}`,
      source: 'sdk',
      frontmatter,
      content: this.options.instructions || '',
      available: gateResult.available,
      unavailableReason: gateResult.reason,
    };

    const handler = this.handler;

    return {
      skill,
      handler,
      async execute(
        context: Omit<SkillExecutionContext, 'skillName' | 'logger' | 'parseArgs' | 'parseArgsPositional'>,
        logger: Logger
      ): Promise<SkillResult> {
        if (!handler) {
          return {
            success: false,
            error: `Skill ${skill.name} has no execution handler`,
          };
        }

        if (!skill.available) {
          return {
            success: false,
            error: skill.unavailableReason || 'Skill is not available',
          };
        }

        const fullContext: SkillExecutionContext = {
          ...context,
          skillName: skill.name,
          logger: logger.child({ skill: skill.name }),
          parseArgs(): Record<string, string> {
            return parseKeyValueArgs(context.args || '');
          },
          parseArgsPositional(): string[] {
            return parsePositionalArgs(context.args || '');
          },
        };

        try {
          return await handler(fullContext);
        } catch (error) {
          const err = error as Error;
          logger.error({ skill: skill.name, error: err.message }, 'Skill execution failed');
          return {
            success: false,
            error: err.message,
          };
        }
      },
    };
  }
}

/**
 * Define a skill using the fluent builder API
 */
export function defineSkill(name: string, description: string): SkillBuilder {
  return new SkillBuilder(name, description);
}

/**
 * Quick skill definition for simple cases
 */
export function createSkill(
  name: string,
  description: string,
  handler: SkillHandler,
  options?: Partial<SkillBuilderOptions>
): SkillDefinition {
  const builder = defineSkill(name, description);

  if (options?.userInvocable !== undefined) builder.userInvocable(options.userInvocable);
  if (options?.disableModelInvocation) builder.disableModelInvocation();
  if (options?.requiredBins?.length) builder.requiresBins(...options.requiredBins);
  if (options?.requiredAnyBins?.length) builder.requiresAnyBins(...options.requiredAnyBins);
  if (options?.requiredEnv?.length) builder.requiresEnv(...options.requiredEnv);
  if (options?.requiredConfig?.length) builder.requiresConfig(...options.requiredConfig);
  if (options?.os) {
    const osValues = Array.isArray(options.os) ? options.os : [options.os];
    builder.forOS(...osValues);
  }
  if (options?.primaryEnv) builder.primaryEnv(options.primaryEnv);
  if (options?.emoji) builder.emoji(options.emoji);
  if (options?.homepage) builder.homepage(options.homepage);
  if (options?.instructions) builder.instructions(options.instructions);

  return builder.onExecute(handler).build();
}

/**
 * Parse key-value arguments (e.g., "key1=value1 key2=value2")
 */
function parseKeyValueArgs(args: string): Record<string, string> {
  const result: Record<string, string> = {};

  // Match key=value pairs, handling quoted values
  const regex = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let match;

  while ((match = regex.exec(args)) !== null) {
    const key = match[1];
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    result[key] = value;
  }

  return result;
}

/**
 * Parse positional arguments (space-separated, handles quotes)
 */
function parsePositionalArgs(args: string): string[] {
  const result: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;

  while ((match = regex.exec(args)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    result.push(value);
  }

  return result;
}

/**
 * Skill registry for SDK-defined skills
 */
export class SDKSkillRegistry {
  private skills: Map<string, SkillDefinition> = new Map();

  /**
   * Register a skill definition
   */
  register(skillDef: SkillDefinition): void {
    this.skills.set(skillDef.skill.name, skillDef);
  }

  /**
   * Get a registered skill
   */
  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  /**
   * Get all registered skills
   */
  getAll(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get all available skills
   */
  getAvailable(): SkillDefinition[] {
    return this.getAll().filter((s) => s.skill.available);
  }

  /**
   * Get user-invocable skills
   */
  getUserInvocable(): SkillDefinition[] {
    return this.getAvailable().filter(
      (s) => s.skill.frontmatter['user-invocable'] !== false
    );
  }

  /**
   * Check if a skill exists
   */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /**
   * Remove a skill
   */
  remove(name: string): boolean {
    return this.skills.delete(name);
  }

  /**
   * Clear all skills
   */
  clear(): void {
    this.skills.clear();
  }

  /**
   * Get skill count
   */
  get size(): number {
    return this.skills.size;
  }
}

/**
 * Global SDK skill registry
 */
export const sdkSkillRegistry = new SDKSkillRegistry();
