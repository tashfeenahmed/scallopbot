/**
 * Skill Registry
 *
 * Central registry for managing skills and providing them to the agent.
 * Handles skill loading, caching, and execution.
 */

import type { Logger } from 'pino';
import type { Skill, SkillContext, SkillResult, SkillRegistryState } from './types.js';
import type { ToolDefinition } from '../providers/types.js';
import { SkillLoader } from './loader.js';

/**
 * Skill execution handler type
 */
export type SkillHandler = (skill: Skill, context: SkillContext) => Promise<SkillResult>;

/**
 * Options for generating skill prompts
 */
export interface GenerateSkillPromptOptions {
  /** Include full skill instructions in prompt (default: false) */
  includeInstructions?: boolean;
  /** Maximum instruction length per skill (default: 500) */
  maxInstructionLength?: number;
}

/**
 * Skill Registry
 */
export class SkillRegistry {
  private loader: SkillLoader;
  private logger: Logger | null;
  private state: SkillRegistryState;
  private executionHandler: SkillHandler | null = null;

  constructor(loader: SkillLoader, logger?: Logger) {
    this.loader = loader;
    this.logger = logger?.child({ module: 'skill-registry' }) || null;
    this.state = {
      skills: new Map(),
      availableSkills: [],
      lastLoaded: 0,
    };
  }

  /**
   * Initialize the registry by loading all skills
   */
  async initialize(): Promise<void> {
    await this.reload();
  }

  /**
   * Reload all skills
   */
  async reload(): Promise<void> {
    const skills = await this.loader.loadAll();

    this.state.skills.clear();
    this.state.availableSkills = [];

    for (const skill of skills) {
      this.state.skills.set(skill.name, skill);
      if (skill.available) {
        this.state.availableSkills.push(skill);
      }
    }

    this.state.lastLoaded = Date.now();

    this.logger?.info(
      {
        total: this.state.skills.size,
        available: this.state.availableSkills.length,
      },
      'Skills registry reloaded'
    );
  }

  /**
   * Get a skill by name
   */
  getSkill(name: string): Skill | undefined {
    return this.state.skills.get(name);
  }

  /**
   * Get all available skills
   */
  getAvailableSkills(): Skill[] {
    return [...this.state.availableSkills];
  }

  /**
   * Get all skills (including unavailable)
   */
  getAllSkills(): Skill[] {
    return Array.from(this.state.skills.values());
  }

  /**
   * Get skills that are user-invocable (can be called via slash commands)
   */
  getUserInvocableSkills(): Skill[] {
    return this.state.availableSkills.filter(
      (skill) => skill.frontmatter['user-invocable'] !== false
    );
  }

  /**
   * Get skills for model prompt (not disabled)
   */
  getModelSkills(): Skill[] {
    return this.state.availableSkills.filter(
      (skill) => skill.frontmatter['disable-model-invocation'] !== true
    );
  }

  /**
   * Get executable skills (have scripts that can be executed)
   */
  getExecutableSkills(): Skill[] {
    return this.state.availableSkills.filter(
      (skill) =>
        skill.hasScripts &&
        skill.frontmatter['disable-model-invocation'] !== true
    );
  }

  /**
   * Get documentation skills (provide context but no scripts)
   * These are typically OpenClaw-style skills that guide the LLM
   */
  getDocumentationSkills(): Skill[] {
    return this.state.availableSkills.filter(
      (skill) =>
        !skill.hasScripts &&
        skill.frontmatter['disable-model-invocation'] !== true
    );
  }

  /**
   * Generate ToolDefinition[] from skills for LLM tool_use protocol
   *
   * Only executable skills (with scripts) become tools.
   * Documentation skills provide context but aren't directly executable.
   */
  getToolDefinitions(): ToolDefinition[] {
    // Only return executable skills as tools
    const skills = this.getExecutableSkills();
    return skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      input_schema: skill.frontmatter.inputSchema || {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    }));
  }

  /**
   * Register a skill programmatically (e.g., native/SDK skills).
   * Added after loader initialization, these survive reload if re-registered.
   */
  registerSkill(skill: Skill): void {
    this.state.skills.set(skill.name, skill);
    if (skill.available && !this.state.availableSkills.find(s => s.name === skill.name)) {
      this.state.availableSkills.push(skill);
    }
    this.logger?.debug({ skill: skill.name, source: skill.source }, 'Skill registered programmatically');
  }

  /**
   * Check if a skill exists
   */
  hasSkill(name: string): boolean {
    return this.state.skills.has(name);
  }

  /**
   * Check if a skill is available
   */
  isSkillAvailable(name: string): boolean {
    const skill = this.state.skills.get(name);
    return skill?.available ?? false;
  }

  /**
   * Set the execution handler for skills
   */
  setExecutionHandler(handler: SkillHandler): void {
    this.executionHandler = handler;
  }

  /**
   * Execute a skill
   */
  async executeSkill(name: string, context: SkillContext): Promise<SkillResult> {
    const skill = this.state.skills.get(name);

    if (!skill) {
      return {
        success: false,
        error: `Skill not found: ${name}`,
      };
    }

    if (!skill.available) {
      return {
        success: false,
        error: `Skill not available: ${skill.unavailableReason || 'Unknown reason'}`,
      };
    }

    // Check for command dispatch (bypass model, invoke tool directly)
    if (skill.frontmatter['command-dispatch'] === 'tool') {
      const toolName = skill.frontmatter['command-tool'];
      if (!toolName) {
        return {
          success: false,
          error: 'Skill has command-dispatch=tool but no command-tool specified',
        };
      }

      // Return instruction to invoke the tool
      return {
        success: true,
        output: JSON.stringify({
          dispatch: 'tool',
          tool: toolName,
          args: context.args,
          argMode: skill.frontmatter['command-arg-mode'],
        }),
      };
    }

    // Use custom handler if set
    if (this.executionHandler) {
      return this.executionHandler(skill, context);
    }

    // Default: return skill content for the model to process
    return {
      success: true,
      output: skill.content,
    };
  }

  /**
   * Generate skill descriptions for model prompt
   */
  generateSkillPrompt(options: GenerateSkillPromptOptions = {}): string {
    const { includeInstructions = false, maxInstructionLength = 500 } = options;
    const executableSkills = this.getExecutableSkills();
    const documentationSkills = this.getDocumentationSkills();

    if (executableSkills.length === 0 && documentationSkills.length === 0) {
      return '';
    }

    const lines: string[] = [];

    // Section 1: Executable skills (can be invoked as tools)
    if (executableSkills.length > 0) {
      lines.push('# Available Skills');
      lines.push('');
      lines.push('You can invoke the following skills directly:');
      lines.push('');

      for (const skill of executableSkills) {
        const emoji = skill.frontmatter.metadata?.openclaw?.emoji || '';
        lines.push(`- **${skill.name}**${emoji ? ` ${emoji}` : ''}: ${skill.description}`);

        // Add input parameter documentation if schema exists
        const schema = skill.frontmatter.inputSchema;
        if (schema && schema.properties && Object.keys(schema.properties).length > 0) {
          const params = this.formatInputSchema(schema);
          if (params) {
            lines.push(`  Parameters: ${params}`);
          }
        }

        if (includeInstructions && skill.content.trim()) {
          const content = skill.content.trim();
          const truncated =
            content.length > maxInstructionLength
              ? content.slice(0, maxInstructionLength) + '...'
              : content;
          lines.push('');
          lines.push(`  Instructions: ${truncated}`);
          lines.push('');
        }
      }
    }

    // Section 2: Documentation skills (lazy-loaded - agent reads SKILL.md when needed)
    if (documentationSkills.length > 0) {
      if (executableSkills.length > 0) {
        lines.push('');
      }
      lines.push('# Skill Guides');
      lines.push('');
      lines.push(
        'These skills provide detailed guidance for specific tasks. ' +
          'IMPORTANT: If exactly one skill clearly applies to the task, you MUST first use read_file ' +
          'to load the full SKILL.md from the path shown, then follow its instructions. ' +
          'Never attempt to use a skill without reading it first.'
      );
      lines.push('');
      lines.push('<available_skills>');

      for (const skill of documentationSkills) {
        const emoji = skill.frontmatter.metadata?.openclaw?.emoji || '';
        lines.push('');
        lines.push(`${skill.name}${emoji ? ` ${emoji}` : ''}`);
        lines.push(skill.description);
        lines.push(skill.path);
      }

      lines.push('');
      lines.push('</available_skills>');
    }

    return lines.join('\n');
  }

  /**
   * Format input schema into concise parameter string
   */
  private formatInputSchema(schema: NonNullable<import('./types.js').SkillFrontmatter['inputSchema']>): string {
    const parts: string[] = [];
    const required = new Set(schema.required || []);

    for (const [name, prop] of Object.entries(schema.properties)) {
      const isRequired = required.has(name);
      const typeStr = isRequired ? prop.type : `${prop.type}, optional`;
      const desc = prop.description ? ` - ${prop.description}` : '';
      parts.push(`${name} (${typeStr})${desc}`);
    }

    return parts.join(', ');
  }

  /**
   * Get formatted list of user-invocable skills for help display
   */
  getSkillHelpText(): string {
    const skills = this.getUserInvocableSkills();

    if (skills.length === 0) {
      return 'No skills available.';
    }

    const lines: string[] = ['Available skills:', ''];

    for (const skill of skills) {
      const emoji = skill.frontmatter.metadata?.openclaw?.emoji || '';
      lines.push(`  /${skill.name}${emoji ? ` ${emoji}` : ''}`);
      lines.push(`    ${skill.description}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Get registry state for debugging/status
   */
  getState(): Readonly<SkillRegistryState> {
    return { ...this.state };
  }
}

/**
 * Create a skill registry with default configuration
 */
export function createSkillRegistry(
  workspaceDir?: string,
  logger?: Logger
): SkillRegistry {
  const loader = new SkillLoader({ workspaceDir }, logger);
  return new SkillRegistry(loader, logger);
}
