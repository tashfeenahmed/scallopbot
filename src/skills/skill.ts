/**
 * Skill System
 * SKILL.md parser, registry, and ClawHub integration
 */

export interface SkillAction {
  name: string;
  description: string;
  parameters?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface SkillMetadata {
  version?: string;
  author?: string;
  license?: string;
  [key: string]: string | undefined;
}

export interface SkillDefinition {
  name: string;
  description: string;
  triggers: string[];
  actions: SkillAction[];
  metadata?: SkillMetadata;
  source?: string;
}

/**
 * Parse a SKILL.md file into a SkillDefinition
 */
export function parseSkillMd(content: string): SkillDefinition {
  if (!content.trim()) {
    throw new Error('Empty SKILL.md content');
  }

  const lines = content.split('\n');
  let name = '';
  let description = '';
  const triggers: string[] = [];
  const actions: SkillAction[] = [];
  const metadata: SkillMetadata = {};

  let currentSection = '';
  let currentAction: Partial<SkillAction> | null = null;
  let collectingJson = false;
  let jsonBuffer = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Parse name from H1
    if (trimmed.startsWith('# ') && !name) {
      name = trimmed.slice(2).trim();
      continue;
    }

    // Parse section headers
    if (trimmed.startsWith('## ')) {
      // Save previous action if exists
      if (currentAction?.name) {
        actions.push(currentAction as SkillAction);
        currentAction = null;
      }
      collectingJson = false;

      currentSection = trimmed.slice(3).toLowerCase().trim();
      continue;
    }

    // Parse action headers (H3)
    if (trimmed.startsWith('### ') && currentSection === 'actions') {
      // Save previous action
      if (currentAction?.name) {
        actions.push(currentAction as SkillAction);
      }

      currentAction = {
        name: trimmed.slice(4).trim(),
        description: '',
      };
      continue;
    }

    // Handle JSON code blocks for parameters
    if (trimmed === '```json') {
      collectingJson = true;
      jsonBuffer = '';
      continue;
    }

    if (trimmed === '```' && collectingJson) {
      collectingJson = false;
      if (currentAction && jsonBuffer) {
        try {
          const parsed = JSON.parse(jsonBuffer);
          // Handle both full JSON schema and simple property list
          if (parsed.type === 'object') {
            currentAction.parameters = parsed;
          } else {
            currentAction.parameters = {
              type: 'object',
              properties: parsed,
            };
          }
        } catch {
          // Invalid JSON, ignore
        }
      }
      jsonBuffer = '';
      continue;
    }

    if (collectingJson) {
      jsonBuffer += line + '\n';
      continue;
    }

    // Parse content based on current section
    switch (currentSection) {
      case 'triggers':
        if (trimmed.startsWith('- ')) {
          triggers.push(trimmed.slice(2).trim());
        }
        break;

      case 'metadata':
        if (trimmed.startsWith('- ')) {
          const match = trimmed.slice(2).match(/^(\w+):\s*(.+)$/);
          if (match) {
            metadata[match[1]] = match[2];
          }
        }
        break;

      case 'actions':
        if (currentAction && trimmed && !trimmed.startsWith('#')) {
          if (!currentAction.description) {
            currentAction.description = trimmed;
          }
        }
        break;

      default:
        // Description is text after the title before any section
        if (!currentSection && trimmed && !description) {
          description = trimmed;
        }
    }
  }

  // Save last action
  if (currentAction?.name) {
    actions.push(currentAction as SkillAction);
  }

  return {
    name,
    description,
    triggers,
    actions,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

/**
 * Registry for loaded skills
 */
export class SkillRegistry {
  private skills: Map<string, SkillDefinition> = new Map();
  private triggerIndex: Map<string, string> = new Map();

  registerSkill(skill: SkillDefinition): void {
    if (this.skills.has(skill.name)) {
      throw new Error(`Skill already registered: ${skill.name}`);
    }

    this.skills.set(skill.name, skill);

    // Index triggers
    for (const trigger of skill.triggers) {
      this.triggerIndex.set(trigger.toLowerCase(), skill.name);
    }
  }

  unregisterSkill(name: string): void {
    const skill = this.skills.get(name);
    if (skill) {
      // Remove trigger index entries
      for (const trigger of skill.triggers) {
        this.triggerIndex.delete(trigger.toLowerCase());
      }
      this.skills.delete(name);
    }
  }

  getSkill(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  hasSkill(name: string): boolean {
    return this.skills.has(name);
  }

  findByTrigger(text: string): SkillDefinition | undefined {
    const lowerText = text.toLowerCase();

    // Check exact match first
    if (this.triggerIndex.has(lowerText)) {
      return this.skills.get(this.triggerIndex.get(lowerText)!);
    }

    // Check if text starts with any trigger
    for (const [trigger, skillName] of this.triggerIndex) {
      if (lowerText.startsWith(trigger)) {
        return this.skills.get(skillName);
      }
    }

    return undefined;
  }

  getAllSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }
}

export interface SkillLoaderOptions {
  registry: SkillRegistry;
  skillsDir: string;
  readFile: (path: string) => Promise<string>;
  readDir: (path: string) => Promise<string[]>;
}

/**
 * Loader for skills with lazy loading support
 */
export class SkillLoader {
  private registry: SkillRegistry;
  private skillsDir: string;
  private readFile: (path: string) => Promise<string>;
  private readDir: (path: string) => Promise<string[]>;
  private lazySkills: Map<string, string> = new Map();
  private loadedLazy: Set<string> = new Set();

  constructor(options: SkillLoaderOptions) {
    this.registry = options.registry;
    this.skillsDir = options.skillsDir;
    this.readFile = options.readFile;
    this.readDir = options.readDir;
  }

  async loadSkill(name: string): Promise<SkillDefinition> {
    const path = `${this.skillsDir}/${name}.md`;
    const content = await this.readFile(path);
    const skill = parseSkillMd(content);
    skill.source = path;
    this.registry.registerSkill(skill);
    return skill;
  }

  async loadAllSkills(): Promise<SkillDefinition[]> {
    const files = await this.readDir(this.skillsDir);
    const skills: SkillDefinition[] = [];

    for (const file of files) {
      if (file.endsWith('.md')) {
        const name = file.slice(0, -3);
        try {
          const skill = await this.loadSkill(name);
          skills.push(skill);
        } catch {
          // Skip invalid skills
        }
      }
    }

    return skills;
  }

  registerLazySkill(name: string, path: string): void {
    this.lazySkills.set(name, path);
  }

  async ensureLoaded(name: string): Promise<void> {
    if (this.loadedLazy.has(name)) {
      return;
    }

    const path = this.lazySkills.get(name);
    if (!path) {
      return;
    }

    const content = await this.readFile(path);
    const skill = parseSkillMd(content);
    skill.source = path;
    this.registry.registerSkill(skill);
    this.loadedLazy.add(name);
  }
}

export interface ClawHubSkillInfo {
  name: string;
  description?: string;
  version?: string;
  downloads?: number;
  content?: string;
}

export interface ClawHubClientOptions {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  apiKey?: string;
}

/**
 * Client for ClawHub skill repository
 */
export class ClawHubClient {
  private baseUrl: string;
  private fetch: typeof globalThis.fetch;
  private apiKey?: string;

  constructor(options: ClawHubClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetch = options.fetch;
    this.apiKey = options.apiKey;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null as T;
      }
      throw new Error(
        `ClawHub API error: ${response.status} ${response.statusText}`
      );
    }

    return response.json();
  }

  async searchSkills(query: string): Promise<ClawHubSkillInfo[]> {
    const result = await this.request<{ skills: ClawHubSkillInfo[] }>(
      `/api/skills/search?q=${encodeURIComponent(query)}`
    );
    return result?.skills ?? [];
  }

  async getSkill(name: string): Promise<ClawHubSkillInfo | null> {
    return this.request<ClawHubSkillInfo>(`/api/skills/${encodeURIComponent(name)}`);
  }

  async installSkill(name: string, version?: string): Promise<string> {
    const versionPath = version ? `@${version}` : '';
    const result = await this.request<ClawHubSkillInfo>(
      `/api/skills/${encodeURIComponent(name)}${versionPath}`
    );
    return result?.content ?? '';
  }

  async listPopular(limit = 10): Promise<ClawHubSkillInfo[]> {
    const result = await this.request<{ skills: ClawHubSkillInfo[] }>(
      `/api/skills/popular?limit=${limit}`
    );
    return result?.skills ?? [];
  }
}
