import type { Tool, ToolRegistry } from './types.js';
import type { ToolDefinition } from '../providers/types.js';
import type { MemoryStore, HybridSearch } from '../memory/index.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { VoiceManager } from '../voice/index.js';

export class ToolRegistryImpl implements ToolRegistry {
  private tools: Map<string, Tool> = new Map();

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
}

/**
 * Options for creating tool registry
 */
export interface ToolRegistryOptions {
  /** Memory store instance for memory tools */
  memoryStore?: MemoryStore;
  /** Hybrid search instance for memory tools */
  hybridSearch?: HybridSearch;
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
  const { BrowserTool } = await import('./browser/index.js');

  const registry = new ToolRegistryImpl();
  registry.registerTool(new ReadTool());
  registry.registerTool(new WriteTool());
  registry.registerTool(new EditTool());
  registry.registerTool(new BashTool());
  registry.registerTool(new BrowserTool());

  // Add memory tools if store is provided
  const includeMemory = options.includeMemoryTools ?? !!options.memoryStore;
  if (includeMemory) {
    const { MemorySearchTool, MemoryGetTool, initializeMemoryTools } = await import('./memory.js');

    if (options.memoryStore) {
      initializeMemoryTools(options.memoryStore, options.hybridSearch);
    }

    registry.registerTool(new MemorySearchTool());
    registry.registerTool(new MemoryGetTool());
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

  return registry;
}
