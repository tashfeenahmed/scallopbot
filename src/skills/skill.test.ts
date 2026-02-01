import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseSkillMd,
  SkillDefinition,
  SkillRegistry,
  SkillLoader,
  ClawHubClient,
} from './skill.js';

describe('parseSkillMd', () => {
  it('should parse minimal SKILL.md', () => {
    const content = `# Calculator

A simple calculator skill.

## Triggers

- calculate
- math

## Actions

### add
Adds two numbers together.

\`\`\`json
{
  "a": "number",
  "b": "number"
}
\`\`\`
`;

    const skill = parseSkillMd(content);

    expect(skill.name).toBe('Calculator');
    expect(skill.description).toBe('A simple calculator skill.');
    expect(skill.triggers).toContain('calculate');
    expect(skill.triggers).toContain('math');
    expect(skill.actions).toHaveLength(1);
    expect(skill.actions[0].name).toBe('add');
  });

  it('should parse multiple actions', () => {
    const content = `# Math

Math operations.

## Triggers

- math

## Actions

### add
Add numbers.

### subtract
Subtract numbers.

### multiply
Multiply numbers.
`;

    const skill = parseSkillMd(content);

    expect(skill.actions).toHaveLength(3);
    expect(skill.actions.map((a) => a.name)).toEqual(['add', 'subtract', 'multiply']);
  });

  it('should parse action parameters from JSON schema', () => {
    const content = `# Calculator

Calculator skill.

## Triggers

- calc

## Actions

### divide

Divides a by b.

\`\`\`json
{
  "type": "object",
  "properties": {
    "a": { "type": "number", "description": "Dividend" },
    "b": { "type": "number", "description": "Divisor" }
  },
  "required": ["a", "b"]
}
\`\`\`
`;

    const skill = parseSkillMd(content);

    expect(skill.actions[0].parameters).toBeDefined();
    expect(skill.actions[0].parameters?.properties).toHaveProperty('a');
    expect(skill.actions[0].parameters?.properties).toHaveProperty('b');
  });

  it('should handle skill with metadata', () => {
    const content = `# Weather

Get weather information.

## Metadata

- version: 1.0.0
- author: LeanBot Team
- license: MIT

## Triggers

- weather

## Actions

### current
Get current weather.
`;

    const skill = parseSkillMd(content);

    expect(skill.metadata).toBeDefined();
    expect(skill.metadata?.version).toBe('1.0.0');
    expect(skill.metadata?.author).toBe('LeanBot Team');
  });

  it('should handle empty content', () => {
    expect(() => parseSkillMd('')).toThrow();
  });

  it('should handle missing triggers section', () => {
    const content = `# NoTriggers

No triggers defined.

## Actions

### something
Does something.
`;

    const skill = parseSkillMd(content);
    expect(skill.triggers).toEqual([]);
  });
});

describe('SkillRegistry', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  describe('registerSkill', () => {
    it('should register a skill', () => {
      const skill: SkillDefinition = {
        name: 'test',
        description: 'Test skill',
        triggers: ['test'],
        actions: [],
      };

      registry.registerSkill(skill);

      expect(registry.hasSkill('test')).toBe(true);
    });

    it('should throw on duplicate registration', () => {
      const skill: SkillDefinition = {
        name: 'test',
        description: 'Test skill',
        triggers: ['test'],
        actions: [],
      };

      registry.registerSkill(skill);

      expect(() => registry.registerSkill(skill)).toThrow();
    });
  });

  describe('getSkill', () => {
    it('should return registered skill', () => {
      const skill: SkillDefinition = {
        name: 'calculator',
        description: 'Calculator',
        triggers: ['calc'],
        actions: [],
      };

      registry.registerSkill(skill);

      expect(registry.getSkill('calculator')).toEqual(skill);
    });

    it('should return undefined for unknown skill', () => {
      expect(registry.getSkill('unknown')).toBeUndefined();
    });
  });

  describe('findByTrigger', () => {
    it('should find skill by trigger', () => {
      const skill: SkillDefinition = {
        name: 'weather',
        description: 'Weather info',
        triggers: ['weather', 'forecast', 'temperature'],
        actions: [],
      };

      registry.registerSkill(skill);

      expect(registry.findByTrigger('forecast')).toEqual(skill);
    });

    it('should return undefined for unknown trigger', () => {
      expect(registry.findByTrigger('unknown')).toBeUndefined();
    });

    it('should find by partial trigger match', () => {
      const skill: SkillDefinition = {
        name: 'reminder',
        description: 'Set reminders',
        triggers: ['remind me', 'set reminder', 'schedule'],
        actions: [],
      };

      registry.registerSkill(skill);

      expect(registry.findByTrigger('remind me to buy milk')).toEqual(skill);
    });
  });

  describe('getAllSkills', () => {
    it('should return all registered skills', () => {
      registry.registerSkill({
        name: 'a',
        description: 'A',
        triggers: [],
        actions: [],
      });
      registry.registerSkill({
        name: 'b',
        description: 'B',
        triggers: [],
        actions: [],
      });

      const skills = registry.getAllSkills();

      expect(skills).toHaveLength(2);
    });
  });

  describe('unregisterSkill', () => {
    it('should remove a skill', () => {
      registry.registerSkill({
        name: 'temp',
        description: 'Temp',
        triggers: ['temp'],
        actions: [],
      });

      registry.unregisterSkill('temp');

      expect(registry.hasSkill('temp')).toBe(false);
    });
  });
});

describe('SkillLoader', () => {
  let loader: SkillLoader;
  let registry: SkillRegistry;
  let mockFs: Record<string, string>;

  beforeEach(() => {
    registry = new SkillRegistry();
    mockFs = {};
    loader = new SkillLoader({
      registry,
      skillsDir: '/skills',
      readFile: async (path: string) => {
        if (mockFs[path]) return mockFs[path];
        throw new Error(`File not found: ${path}`);
      },
      readDir: async (path: string) => {
        return Object.keys(mockFs)
          .filter((p) => p.startsWith(path))
          .map((p) => p.split('/').pop()!)
          .filter((n) => n.endsWith('.md'));
      },
    });
  });

  describe('loadSkill', () => {
    it('should load skill from file', async () => {
      mockFs['/skills/calculator.md'] = `# Calculator

A calculator.

## Triggers

- calc

## Actions

### add
Add numbers.
`;

      await loader.loadSkill('calculator');

      expect(registry.hasSkill('Calculator')).toBe(true);
    });

    it('should throw for non-existent skill', async () => {
      await expect(loader.loadSkill('nonexistent')).rejects.toThrow();
    });
  });

  describe('loadAllSkills', () => {
    it('should load all skills from directory', async () => {
      mockFs['/skills/calc.md'] = `# Calc

Calc.

## Actions

### add
Add.
`;
      mockFs['/skills/weather.md'] = `# Weather

Weather.

## Actions

### current
Current.
`;

      await loader.loadAllSkills();

      expect(registry.getAllSkills()).toHaveLength(2);
    });
  });

  describe('lazy loading', () => {
    it('should not load skill until requested', async () => {
      mockFs['/skills/lazy.md'] = `# Lazy

Lazy skill.

## Triggers

- lazy

## Actions

### test
Test.
`;

      // Just register the path, don't load
      loader.registerLazySkill('lazy', '/skills/lazy.md');

      expect(registry.hasSkill('Lazy')).toBe(false);

      // Now load on demand
      await loader.ensureLoaded('lazy');

      expect(registry.hasSkill('Lazy')).toBe(true);
    });

    it('should only load once even if called multiple times', async () => {
      const readFileSpy = vi.fn().mockResolvedValue(`# Once

Once skill.

## Actions

### test
Test.
`);

      loader = new SkillLoader({
        registry,
        skillsDir: '/skills',
        readFile: readFileSpy,
        readDir: async () => [],
      });

      loader.registerLazySkill('once', '/skills/once.md');

      await loader.ensureLoaded('once');
      await loader.ensureLoaded('once');
      await loader.ensureLoaded('once');

      expect(readFileSpy).toHaveBeenCalledTimes(1);
    });
  });
});

describe('ClawHubClient', () => {
  let client: ClawHubClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    client = new ClawHubClient({
      baseUrl: 'https://clawhub.example.com',
      fetch: mockFetch,
    });
  });

  describe('searchSkills', () => {
    it('should search for skills', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          skills: [
            { name: 'calculator', description: 'Math operations', version: '1.0.0' },
            { name: 'weather', description: 'Weather info', version: '2.1.0' },
          ],
        }),
      });

      const results = await client.searchSkills('math');

      expect(results).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('search'),
        expect.any(Object)
      );
    });

    it('should return empty array for no results', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ skills: [] }),
      });

      const results = await client.searchSkills('nonexistent');

      expect(results).toEqual([]);
    });

    it('should handle API errors', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(client.searchSkills('test')).rejects.toThrow();
    });
  });

  describe('getSkill', () => {
    it('should fetch skill details', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          name: 'calculator',
          description: 'Math operations',
          version: '1.0.0',
          content: '# Calculator\n...',
        }),
      });

      const skill = await client.getSkill('calculator');

      expect(skill.name).toBe('calculator');
      expect(skill.content).toBeDefined();
    });

    it('should return null for unknown skill', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      const skill = await client.getSkill('unknown');

      expect(skill).toBeNull();
    });
  });

  describe('installSkill', () => {
    it('should download and return skill content', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          name: 'newskill',
          content: `# NewSkill

New skill content.

## Actions

### test
Test action.
`,
        }),
      });

      const content = await client.installSkill('newskill');

      expect(content).toContain('# NewSkill');
    });

    it('should handle specific version', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          name: 'versioned',
          version: '2.0.0',
          content: '# Versioned\n...',
        }),
      });

      await client.installSkill('versioned', '2.0.0');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('2.0.0'),
        expect.any(Object)
      );
    });
  });

  describe('listPopular', () => {
    it('should list popular skills', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          skills: [
            { name: 'popular1', downloads: 1000 },
            { name: 'popular2', downloads: 500 },
          ],
        }),
      });

      const popular = await client.listPopular();

      expect(popular).toHaveLength(2);
      expect(popular[0].downloads).toBeGreaterThan(popular[1].downloads);
    });
  });
});
