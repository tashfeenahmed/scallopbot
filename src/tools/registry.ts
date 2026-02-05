import type { Tool, ToolRegistry, ToolCategory, ToolPolicy, ToolGroup } from './types.js';
import type { ToolDefinition } from '../providers/types.js';
import type { SkillRegistry } from '../skills/registry.js';

/**
 * Standard tool groups (kept for policy filtering compatibility)
 */
export const STANDARD_GROUPS: ToolGroup[] = [];

export class ToolRegistryImpl implements ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private policy: ToolPolicy | undefined;
  private groups: Map<string, ToolGroup> = new Map();

  constructor() {
    for (const group of STANDARD_GROUPS) {
      this.groups.set(group.id, group);
    }
  }

  // Core registration methods
  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  getToolDefinitions(): ToolDefinition[] {
    return this.getAllTools().map((tool) => tool.definition);
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  removeTool(name: string): boolean {
    return this.tools.delete(name);
  }

  clear(): void {
    this.tools.clear();
  }

  // Category methods
  getToolsByCategory(category: ToolCategory): Tool[] {
    return this.getAllTools().filter((tool) => tool.category === category);
  }

  getCategories(): ToolCategory[] {
    const categories = new Set<ToolCategory>();
    for (const tool of this.tools.values()) {
      categories.add(tool.category);
    }
    return Array.from(categories);
  }

  // Policy filtering methods
  setPolicy(policy: ToolPolicy): void {
    this.policy = policy;
  }

  getPolicy(): ToolPolicy | undefined {
    return this.policy;
  }

  clearPolicy(): void {
    this.policy = undefined;
  }

  isToolAllowed(name: string): boolean {
    if (!this.policy) return true;

    const tool = this.tools.get(name);
    if (!tool) return false;

    const { mode, tools, categories } = this.policy;
    const nameMatch = tools?.includes(name) ?? false;
    const categoryMatch = categories?.includes(tool.category) ?? false;
    const inPolicy = nameMatch || categoryMatch;

    return mode === 'allowlist' ? inPolicy : !inPolicy;
  }

  getFilteredTools(): Tool[] {
    if (!this.policy) return this.getAllTools();
    return this.getAllTools().filter((tool) => this.isToolAllowed(tool.name));
  }

  getFilteredToolDefinitions(): ToolDefinition[] {
    return this.getFilteredTools().map((tool) => tool.definition);
  }

  // Group methods
  registerGroup(group: ToolGroup): void {
    this.groups.set(group.id, group);
  }

  getGroup(id: string): ToolGroup | undefined {
    return this.groups.get(id);
  }

  getAllGroups(): ToolGroup[] {
    return Array.from(this.groups.values());
  }

  getGroupTools(groupId: string): Tool[] {
    const group = this.groups.get(groupId);
    if (!group) return [];

    return group.tools
      .map((name) => this.tools.get(name))
      .filter((tool): tool is Tool => tool !== undefined)
      .filter((tool) => this.isToolAllowed(tool.name));
  }
}

/**
 * Options for creating tool registry
 *
 * All tools have been migrated to skills. The tool registry now only manages
 * the Skill meta-tool (for invoking skills by name via legacy path).
 */
export interface ToolRegistryOptions {
  /** Skill registry for skill tool */
  skillRegistry?: SkillRegistry;
  /** Whether to include skill tool (default: true if skillRegistry provided) */
  includeSkillTool?: boolean;
  /** Initial tool policy */
  toolPolicy?: ToolPolicy;
  /** Additional tool groups to register */
  additionalGroups?: ToolGroup[];
}

/**
 * Create a tool registry.
 *
 * All tools have been migrated to skills (native or bundled).
 * The registry now only optionally registers the Skill meta-tool.
 */
export async function createDefaultToolRegistry(
  options: ToolRegistryOptions = {}
): Promise<ToolRegistryImpl> {
  const registry = new ToolRegistryImpl();

  // Add skill tool if registry is provided
  const includeSkill = options.includeSkillTool ?? !!options.skillRegistry;
  if (includeSkill && options.skillRegistry) {
    const { SkillTool, initializeSkillTool } = await import('./skill.js');
    initializeSkillTool(options.skillRegistry);
    registry.registerTool(new SkillTool());
  }

  // Apply initial policy if provided
  if (options.toolPolicy) {
    registry.setPolicy(options.toolPolicy);
  }

  // Register additional groups
  if (options.additionalGroups) {
    for (const group of options.additionalGroups) {
      registry.registerGroup(group);
    }
  }

  return registry;
}
