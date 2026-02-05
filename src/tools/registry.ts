import type { Tool, ToolRegistry, ToolCategory, ToolPolicy, ToolGroup } from './types.js';
import type { ToolDefinition } from '../providers/types.js';
import type { MemoryStore, HybridSearch, ScallopMemoryStore } from '../memory/index.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { VoiceManager } from '../voice/index.js';
import type { FileSendCallback } from './file-send.js';
import type { MessageSendCallback } from './message-send.js';

/**
 * Standard tool groups for common workflows
 * Note: File/dev/search tools are now provided by skills (read_file, write_file, edit_file, bash, web_search).
 * These groups reference the legacy tool names for backward compatibility with policies.
 */
export const STANDARD_GROUPS: ToolGroup[] = [
  { id: 'comms', name: 'Communication', description: 'Message and file sending tools', tools: ['send_message', 'send_file', 'voice_reply'] },
];

export class ToolRegistryImpl implements ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private policy: ToolPolicy | undefined;
  private groups: Map<string, ToolGroup> = new Map();

  constructor() {
    // Register standard groups by default
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

    // Check if tool name is in the list
    const nameMatch = tools?.includes(name) ?? false;

    // Check if tool category is in the list
    const categoryMatch = categories?.includes(tool.category) ?? false;

    const inPolicy = nameMatch || categoryMatch;

    // Allowlist: must be in policy to be allowed
    // Denylist: must NOT be in policy to be allowed
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
 * Note: Most tools (read, write, edit, bash, web_search, memory_search, reminder)
 * have been migrated to skills. The tool registry now only manages:
 * - Communication tools (send_file, send_message, voice_reply)
 * - Memory get tool (memory_get - no skill equivalent yet)
 * - Skill meta-tool (for invoking skills by name)
 */
export interface ToolRegistryOptions {
  /** Memory store instance for memory_get tool */
  memoryStore?: MemoryStore;
  /** Hybrid search instance for memory_get tool */
  hybridSearch?: HybridSearch;
  /** ScallopMemoryStore (SQLite) - preferred backend for memory_get tool */
  scallopStore?: ScallopMemoryStore;
  /** Whether to include memory_get tool (default: true if memoryStore provided) */
  includeMemoryTools?: boolean;
  /** Skill registry for skill tool */
  skillRegistry?: SkillRegistry;
  /** Whether to include skill tool (default: true if skillRegistry provided) */
  includeSkillTool?: boolean;
  /** Voice manager for voice reply tool */
  voiceManager?: VoiceManager;
  /** Whether to include voice tool (default: true if voiceManager provided) */
  includeVoiceTool?: boolean;
  /** Initial tool policy */
  toolPolicy?: ToolPolicy;
  /** Additional tool groups to register */
  additionalGroups?: ToolGroup[];
  /** Callback for sending files to user */
  fileSendCallback?: FileSendCallback;
  /** Whether to include file send tool (default: true if fileSendCallback provided) */
  includeFileSendTool?: boolean;
  /** Callback for sending messages to user immediately */
  messageSendCallback?: MessageSendCallback;
  /** Whether to include message send tool (default: true if messageSendCallback provided) */
  includeMessageSendTool?: boolean;
}

/**
 * Create a registry with the remaining legacy tools.
 *
 * Most tools have been migrated to skills:
 * - read → read_file skill
 * - write → write_file skill
 * - edit → edit_file skill
 * - bash → bash skill
 * - web_search → web_search skill
 * - memory_search → memory_search skill
 * - reminder → reminder skill
 *
 * This registry now manages only:
 * - memory_get (no skill equivalent)
 * - Skill meta-tool
 * - voice_reply, send_file, send_message (comms tools)
 */
export async function createDefaultToolRegistry(
  options: ToolRegistryOptions = {}
): Promise<ToolRegistryImpl> {
  const registry = new ToolRegistryImpl();

  // Add memory_get tool if store is provided (no skill equivalent yet)
  const includeMemory = options.includeMemoryTools ?? !!(options.memoryStore || options.scallopStore);
  if (includeMemory) {
    const { MemoryGetTool, initializeMemoryTools } = await import('./memory.js');

    if (options.memoryStore) {
      initializeMemoryTools(options.memoryStore, options.hybridSearch, options.scallopStore);
    }

    const memToolOpts = { scallopStore: options.scallopStore };
    registry.registerTool(new MemoryGetTool(memToolOpts));
  }

  // Add skill tool if registry is provided
  const includeSkill = options.includeSkillTool ?? !!options.skillRegistry;
  if (includeSkill && options.skillRegistry) {
    const { SkillTool, initializeSkillTool } = await import('./skill.js');
    initializeSkillTool(options.skillRegistry);
    registry.registerTool(new SkillTool());
  }

  // Add voice tool if voice manager is provided
  const includeVoice = options.includeVoiceTool ?? !!options.voiceManager;
  if (includeVoice && options.voiceManager) {
    const { VoiceReplyTool } = await import('./voice.js');
    registry.registerTool(new VoiceReplyTool({ voiceManager: options.voiceManager }));
  }

  // Add file send tool if callback is provided
  const includeFileSend = options.includeFileSendTool ?? !!options.fileSendCallback;
  if (includeFileSend && options.fileSendCallback) {
    const { FileSendTool, initializeFileSend } = await import('./file-send.js');
    initializeFileSend(options.fileSendCallback);
    registry.registerTool(new FileSendTool());
  }

  // Add message send tool if callback is provided
  const includeMessageSend = options.includeMessageSendTool ?? !!options.messageSendCallback;
  if (includeMessageSend && options.messageSendCallback) {
    const { MessageSendTool, initializeMessageSend } = await import('./message-send.js');
    initializeMessageSend(options.messageSendCallback);
    registry.registerTool(new MessageSendTool());
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
