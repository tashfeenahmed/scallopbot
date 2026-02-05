import type { Tool, ToolRegistry, ToolCategory, ToolPolicy, ToolGroup } from './types.js';
import type { ToolDefinition } from '../providers/types.js';
import type { MemoryStore, HybridSearch, ScallopMemoryStore } from '../memory/index.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { VoiceManager } from '../voice/index.js';
import type { ReminderCallback } from './reminder.js';
import type { FileSendCallback } from './file-send.js';
import type { MessageSendCallback } from './message-send.js';

/**
 * Standard tool groups for common workflows
 */
export const STANDARD_GROUPS: ToolGroup[] = [
  { id: 'fs', name: 'File System', description: 'File read/write/edit operations', tools: ['read', 'write', 'edit'] },
  { id: 'dev', name: 'Development', description: 'Full development workflow', tools: ['read', 'write', 'edit', 'bash'] },
  { id: 'web', name: 'Web', description: 'Web browsing and search', tools: ['web_search'] },
  { id: 'all-coding', name: 'All Coding', description: 'All coding-related tools', tools: ['read', 'write', 'edit', 'bash'] },
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
 */
export interface ToolRegistryOptions {
  /** Memory store instance for memory tools */
  memoryStore?: MemoryStore;
  /** Hybrid search instance for memory tools */
  hybridSearch?: HybridSearch;
  /** ScallopMemoryStore (SQLite) - preferred backend for memory tools */
  scallopStore?: ScallopMemoryStore;
  /** Whether to include memory tools (default: true if memoryStore provided) */
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
  /** Callback for when reminders trigger */
  reminderCallback?: ReminderCallback;
  /** Whether to include reminder tool (default: true if reminderCallback provided) */
  includeReminderTool?: boolean;
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
 * Create a registry with all default tools
 */
export async function createDefaultToolRegistry(
  options: ToolRegistryOptions = {}
): Promise<ToolRegistryImpl> {
  const { ReadTool } = await import('./read.js');
  const { WriteTool } = await import('./write.js');
  const { EditTool } = await import('./edit.js');
  const { BashTool } = await import('./bash.js');

  const registry = new ToolRegistryImpl();
  registry.registerTool(new ReadTool());
  registry.registerTool(new WriteTool());
  registry.registerTool(new EditTool());
  registry.registerTool(new BashTool());

  // Add memory tools if store is provided
  const includeMemory = options.includeMemoryTools ?? !!(options.memoryStore || options.scallopStore);
  if (includeMemory) {
    const { MemorySearchTool, MemoryGetTool, initializeMemoryTools } = await import('./memory.js');

    if (options.memoryStore) {
      initializeMemoryTools(options.memoryStore, options.hybridSearch, options.scallopStore);
    }

    const memToolOpts = { scallopStore: options.scallopStore };
    registry.registerTool(new MemorySearchTool(memToolOpts));
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

  // Add Brave Search tool if API key is available
  const { initializeBraveSearch } = await import('./search.js');
  const braveSearch = initializeBraveSearch();
  if (braveSearch) {
    registry.registerTool(braveSearch);
  }

  // Add reminder tool if callback is provided
  const includeReminder = options.includeReminderTool ?? !!options.reminderCallback;
  if (includeReminder && options.reminderCallback) {
    const { ReminderTool, initializeReminders } = await import('./reminder.js');
    initializeReminders(options.reminderCallback);
    registry.registerTool(new ReminderTool());
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
