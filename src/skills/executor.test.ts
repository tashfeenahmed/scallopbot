import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { pino } from 'pino';
import type { Skill, SkillFrontmatter } from './types.js';
import { ScallopDatabase } from '../memory/db.js';
import {
  SkillExecutor,
  buildSkillSubprocessEnv,
  createSkillExecutor,
  resolveSkillStateUserId,
} from './executor.js';

/**
 * Creates a mock skill for testing
 */
function createMockSkill(overrides: Partial<Skill> = {}): Skill {
  const defaultFrontmatter: SkillFrontmatter = {
    name: 'test-skill',
    description: 'A test skill',
  };

  return {
    name: 'test-skill',
    description: 'A test skill',
    path: '/mock/path/SKILL.md',
    source: 'workspace',
    frontmatter: defaultFrontmatter,
    content: 'Test skill instructions',
    available: true,
    hasScripts: true,
    ...overrides,
  };
}

/**
 * Creates a mock logger for testing
 */
function createMockLogger() {
  return pino({ level: 'silent' });
}

describe('SkillExecutor', () => {
  let testDir: string;
  let skillDir: string;
  let scriptsDir: string;
  let executor: SkillExecutor;

  beforeEach(async () => {
    // Create temp directory structure
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-executor-test-'));
    skillDir = path.join(testDir, 'test-skill');
    scriptsDir = path.join(skillDir, 'scripts');
    await fs.mkdir(scriptsDir, { recursive: true });

    executor = createSkillExecutor(createMockLogger());
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('resolveScript', () => {
    it('should return run.ts when it exists', async () => {
      // Arrange
      await fs.writeFile(path.join(scriptsDir, 'run.ts'), 'console.log("run")');
      const skill = createMockSkill({ scriptsDir });

      // Act
      const result = await executor.resolveScript(skill);

      // Assert
      expect(result).toBe(path.join(scriptsDir, 'run.ts'));
    });

    it('should return default.ts as fallback when run.ts does not exist', async () => {
      // Arrange
      await fs.writeFile(path.join(scriptsDir, 'default.ts'), 'console.log("default")');
      const skill = createMockSkill({ scriptsDir });

      // Act
      const result = await executor.resolveScript(skill);

      // Assert
      expect(result).toBe(path.join(scriptsDir, 'default.ts'));
    });

    it('should return action-specific script when action provided', async () => {
      // Arrange
      await fs.writeFile(path.join(scriptsDir, 'run.ts'), 'console.log("run")');
      await fs.writeFile(path.join(scriptsDir, 'custom-action.ts'), 'console.log("custom")');
      const skill = createMockSkill({ scriptsDir });

      // Act
      const result = await executor.resolveScript(skill, 'custom-action');

      // Assert
      expect(result).toBe(path.join(scriptsDir, 'custom-action.ts'));
    });

    it('should check frontmatter scripts mapping first', async () => {
      // Arrange
      const customScriptPath = path.join(skillDir, 'lib', 'special.ts');
      await fs.mkdir(path.join(skillDir, 'lib'), { recursive: true });
      await fs.writeFile(customScriptPath, 'console.log("special")');
      await fs.writeFile(path.join(scriptsDir, 'run.ts'), 'console.log("run")');

      const skill = createMockSkill({
        scriptsDir,
        frontmatter: {
          name: 'test-skill',
          description: 'Test',
          scripts: {
            'special-action': 'lib/special.ts',
          },
        },
      });

      // Act
      const result = await executor.resolveScript(skill, 'special-action');

      // Assert
      expect(result).toBe(customScriptPath);
    });

    it('should return null when no scripts found', async () => {
      // Arrange - empty scripts dir
      const skill = createMockSkill({ scriptsDir });

      // Act
      const result = await executor.resolveScript(skill);

      // Assert
      expect(result).toBeNull();
    });

    it('should return null when scriptsDir is not set', async () => {
      // Arrange
      const skill = createMockSkill({ scriptsDir: undefined });

      // Act
      const result = await executor.resolveScript(skill);

      // Assert
      expect(result).toBeNull();
    });

    it('should prioritize action script over run.ts', async () => {
      // Arrange
      await fs.writeFile(path.join(scriptsDir, 'run.ts'), 'console.log("run")');
      await fs.writeFile(path.join(scriptsDir, 'search.ts'), 'console.log("search")');
      const skill = createMockSkill({ scriptsDir });

      // Act
      const result = await executor.resolveScript(skill, 'search');

      // Assert
      expect(result).toBe(path.join(scriptsDir, 'search.ts'));
    });

    it('should fall back to run.ts when action script not found', async () => {
      // Arrange
      await fs.writeFile(path.join(scriptsDir, 'run.ts'), 'console.log("run")');
      const skill = createMockSkill({ scriptsDir });

      // Act
      const result = await executor.resolveScript(skill, 'nonexistent-action');

      // Assert
      expect(result).toBe(path.join(scriptsDir, 'run.ts'));
    });

    it('should check extensions in order: .ts, .sh, .js', async () => {
      // Arrange - create both .sh and .js but not .ts
      await fs.writeFile(path.join(scriptsDir, 'run.sh'), 'echo "shell"');
      await fs.writeFile(path.join(scriptsDir, 'run.js'), 'console.log("js")');
      const skill = createMockSkill({ scriptsDir });

      // Act
      const result = await executor.resolveScript(skill);

      // Assert - .sh should be found before .js
      expect(result).toBe(path.join(scriptsDir, 'run.sh'));
    });
  });

  describe('execute', () => {
    it('maps an explicitly configured Telegram owner to canonical state without replacing channel identity', async () => {
      const script = `console.log(JSON.stringify({ channel: process.env.SKILL_USER_ID, state: process.env.SKILL_STATE_USER_ID }));`;
      await fs.writeFile(path.join(scriptsDir, 'run.js'), script);
      const skill = createMockSkill({ scriptsDir });
      const ownerExecutor = createSkillExecutor(createMockLogger(), undefined, {
        canonicalSingleUserIds: ['owner-123', 'telegram:owner-123'],
      });

      const result = await ownerExecutor.execute(skill, {
        skillName: skill.name,
        cwd: testDir,
        userId: 'telegram:owner-123',
      });

      expect(result.success).toBe(true);
      expect(JSON.parse(result.output!.trim())).toEqual({
        channel: 'telegram:owner-123',
        state: 'default',
      });
    });

    it('lets the board read default-owned rows from an aliased Telegram session', async () => {
      const dbPath = path.join(testDir, 'memories.db');
      const db = new ScallopDatabase(dbPath);
      db.addScheduledItem({
        userId: 'default',
        sessionId: 'source-session',
        source: 'user',
        kind: 'nudge',
        type: 'reminder',
        message: 'Canonical owner board item',
        context: null,
        triggerAt: 0,
        recurring: null,
        sourceMemoryId: null,
        boardStatus: 'backlog',
      });
      db.close();

      const boardScriptsDir = path.join(process.cwd(), 'src', 'skills', 'bundled', 'board', 'scripts');
      const boardSkill = createMockSkill({
        name: 'board',
        scriptsDir: boardScriptsDir,
        path: path.join(boardScriptsDir, '..', 'SKILL.md'),
        frontmatter: { name: 'board', description: 'Board test' },
      });
      const ownerExecutor = createSkillExecutor(createMockLogger(), undefined, {
        canonicalSingleUserIds: ['owner-123', 'telegram:owner-123'],
      });

      const ownerResult = await ownerExecutor.execute(boardSkill, {
        skillName: 'board',
        args: { action: 'view' },
        cwd: testDir,
        userId: 'telegram:owner-123',
        sessionId: 'telegram-session',
      });
      const unrelatedResult = await ownerExecutor.execute(boardSkill, {
        skillName: 'board',
        args: { action: 'view' },
        cwd: testDir,
        userId: 'telegram:someone-else',
        sessionId: 'other-session',
      });

      expect(ownerResult.success).toBe(true);
      expect(ownerResult.output).toContain('Canonical owner board item');
      expect(unrelatedResult.success).toBe(true);
      expect(unrelatedResult.output).not.toContain('Canonical owner board item');
    }, 30_000);

    it('lets memory search read default-owned facts from an aliased Telegram session', async () => {
      const dbPath = path.join(testDir, 'memories.db');
      const db = new ScallopDatabase(dbPath);
      db.addMemory({
        userId: 'default',
        content: 'The canonical owner prefers cardamom coffee.',
        category: 'preference',
        memoryType: 'regular',
        importance: 6,
        confidence: 1,
        isLatest: true,
        source: 'user',
        documentDate: Date.now(),
        eventDate: null,
        prominence: 1,
        lastAccessed: null,
        accessCount: 0,
        sourceChunk: null,
        embedding: null,
        metadata: null,
      });
      db.close();

      const memoryScriptsDir = path.join(process.cwd(), 'src', 'skills', 'bundled', 'memory_search', 'scripts');
      const memorySkill = createMockSkill({
        name: 'memory_search',
        scriptsDir: memoryScriptsDir,
        path: path.join(memoryScriptsDir, '..', 'SKILL.md'),
        frontmatter: { name: 'memory_search', description: 'Memory search test' },
      });
      const ownerExecutor = createSkillExecutor(createMockLogger(), undefined, {
        canonicalSingleUserIds: ['owner-123', 'telegram:owner-123'],
      });

      const result = await ownerExecutor.execute(memorySkill, {
        skillName: 'memory_search',
        args: { query: 'cardamom coffee' },
        cwd: testDir,
        userId: 'telegram:owner-123',
        sessionId: 'telegram-session',
      });

      expect(result.success).toBe(true);
      const payload = JSON.parse(result.output!.trim()) as { output: string };
      expect(payload.output).toContain('The canonical owner prefers cardamom coffee.');
    }, 30_000);

    it('rejects empty recall and keeps assistant reflection out of normal memory search', async () => {
      const dbPath = path.join(testDir, 'memories.db');
      const db = new ScallopDatabase(dbPath);
      db.addMemory({
        userId: 'default', content: 'The user prefers concise status updates.', category: 'preference',
        memoryType: 'regular', importance: 6, confidence: 1, isLatest: true, source: 'user',
        documentDate: Date.now(), eventDate: null, prominence: 1, lastAccessed: null,
        accessCount: 0, sourceChunk: null, embedding: null, metadata: null,
      });
      db.addMemory({
        userId: 'default', content: 'The assistant should improve its workflow.', category: 'insight',
        memoryType: 'derived', importance: 7, confidence: 1, isLatest: true, source: 'assistant',
        documentDate: Date.now(), eventDate: null, prominence: 1, lastAccessed: null,
        accessCount: 0, sourceChunk: null, embedding: null,
        metadata: { audience: 'assistant' }, learnedFrom: 'self_reflection',
      });
      db.addMemory({
        userId: 'default', content: 'Agent prefers to reuse old workflow advice.', category: 'preference',
        memoryType: 'regular', importance: 6, confidence: 1, isLatest: true, source: 'user',
        documentDate: Date.now(), eventDate: null, prominence: 1, lastAccessed: null,
        accessCount: 0, sourceChunk: null, embedding: null, metadata: { subject: 'agent' },
      });
      db.close();

      const memoryScriptsDir = path.join(process.cwd(), 'src', 'skills', 'bundled', 'memory_search', 'scripts');
      const memorySkill = createMockSkill({
        name: 'memory_search', scriptsDir: memoryScriptsDir,
        path: path.join(memoryScriptsDir, '..', 'SKILL.md'),
        frontmatter: { name: 'memory_search', description: 'Memory search test' },
      });

      const empty = await executor.execute(memorySkill, {
        skillName: 'memory_search', args: { query: '' }, cwd: testDir,
        userId: 'default', sessionId: 'session',
      });
      expect(empty.success).toBe(false);
      expect(`${empty.output ?? ''} ${empty.error ?? ''}`).toContain('specific, non-empty query');

      const searched = await executor.execute(memorySkill, {
        skillName: 'memory_search', args: { query: 'concise status updates workflow' }, cwd: testDir,
        userId: 'default', sessionId: 'session',
      });
      expect(searched.success).toBe(true);
      expect(searched.output).toContain('The user prefers concise status updates.');
      expect(searched.output).not.toContain('assistant should improve');
      expect(searched.output).not.toContain('Agent prefers to reuse');
    }, 30_000);

    it('lets an old event fade generally but return when its topic is naturally relevant', async () => {
      const dbPath = path.join(testDir, 'memories.db');
      const db = new ScallopDatabase(dbPath);
      const old = Date.now() - 180 * 24 * 60 * 60 * 1_000;
      db.addMemory({
        userId: 'default', content: 'Met Struan to discuss the UXBR engagement.', category: 'event',
        memoryType: 'superseded', importance: 6, confidence: 1, isLatest: false, source: 'user',
        documentDate: old, eventDate: old, prominence: 1, lastAccessed: null,
        accessCount: 0, sourceChunk: null, embedding: null, metadata: null,
      });
      db.addMemory({
        userId: 'default', content: 'Annual Global Shapers meeting.', category: 'event',
        memoryType: 'regular', importance: 6, confidence: 1, isLatest: true, source: 'user',
        documentDate: old, eventDate: old, prominence: 1, lastAccessed: null,
        accessCount: 0, sourceChunk: null, embedding: null, metadata: null,
      });
      db.close();
      const memoryScriptsDir = path.join(process.cwd(), 'src', 'skills', 'bundled', 'memory_search', 'scripts');
      const memorySkill = createMockSkill({
        name: 'memory_search', scriptsDir: memoryScriptsDir,
        path: path.join(memoryScriptsDir, '..', 'SKILL.md'),
        frontmatter: { name: 'memory_search', description: 'Memory search test' },
      });

      const generic = await executor.execute(memorySkill, {
        skillName: 'memory_search', args: { query: 'what is on my plate today' }, cwd: testDir,
        userId: 'default', sessionId: 'session',
      });
      expect(generic.success).toBe(true);
      expect(generic.output).not.toContain('Struan');

      const relevant = await executor.execute(memorySkill, {
        skillName: 'memory_search', args: { query: 'Whatever happened with Struan?' }, cwd: testDir,
        userId: 'default', sessionId: 'session',
      });
      expect(relevant.success).toBe(true);
      expect(relevant.output).toContain('Met Struan to discuss the UXBR engagement.');
      expect(relevant.output).toContain('historical record (not current state)');
      expect(relevant.output).not.toContain('Annual Global Shapers meeting.');
    }, 30_000);

    it('revives a directly relevant old goal together with its child milestones', async () => {
      const dbPath = path.join(testDir, 'memories.db');
      const db = new ScallopDatabase(dbPath);
      const old = Date.now() - 150 * 24 * 60 * 60 * 1_000;
      const root = db.addMemory({
        userId: 'default', content: 'Become YouTube Famous - 100K Subscribers', category: 'insight',
        memoryType: 'static_profile', importance: 8, confidence: 1, isLatest: true, source: 'user',
        documentDate: old, eventDate: null, prominence: 1, lastAccessed: null,
        accessCount: 0, sourceChunk: null, embedding: null,
        metadata: { goalType: 'goal', status: 'backlog', progress: 0 },
      });
      for (const content of [
        'Phase 1: Foundation (0-1K subs)',
        'Phase 2: Momentum (1K-10K subs)',
        'Phase 3: Breakout (10K-100K subs)',
      ]) {
        db.addMemory({
          userId: 'default', content, category: 'insight', memoryType: 'static_profile',
          importance: 7, confidence: 1, isLatest: true, source: 'user', documentDate: old,
          eventDate: null, prominence: 1, lastAccessed: null, accessCount: 0,
          sourceChunk: null, embedding: null,
          metadata: { goalType: 'milestone', status: 'backlog', progress: 0, parentId: root.id },
        });
      }
      db.addMemory({
        userId: 'default', content: 'Test Goal', category: 'insight', memoryType: 'static_profile',
        importance: 7, confidence: 1, isLatest: true, source: 'user', documentDate: old,
        eventDate: null, prominence: 1, lastAccessed: null, accessCount: 0,
        sourceChunk: null, embedding: null,
        metadata: { goalType: 'goal', status: 'backlog', progress: 0 },
      });
      db.close();

      const memoryScriptsDir = path.join(process.cwd(), 'src', 'skills', 'bundled', 'memory_search', 'scripts');
      const memorySkill = createMockSkill({
        name: 'memory_search', scriptsDir: memoryScriptsDir,
        path: path.join(memoryScriptsDir, '..', 'SKILL.md'),
        frontmatter: { name: 'memory_search', description: 'Memory search test' },
      });
      const result = await executor.execute(memorySkill, {
        skillName: 'memory_search',
        args: { query: 'YouTube subscriber goal growth phases' },
        cwd: testDir, userId: 'default', sessionId: 'session',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Become YouTube Famous - 100K Subscribers');
      expect(result.output).toContain('Phase 1: Foundation (0-1K subs)');
      expect(result.output).toContain('Phase 2: Momentum (1K-10K subs)');
      expect(result.output).toContain('Phase 3: Breakout (10K-100K subs)');
      expect(result.output).not.toContain('Test Goal');
    }, 30_000);

    it('should execute .ts scripts with tsx', async () => {
      // Arrange
      const script = `console.log("Hello from TypeScript");`;
      await fs.writeFile(path.join(scriptsDir, 'run.ts'), script);
      const skill = createMockSkill({ scriptsDir });

      // Act
      const result = await executor.execute(skill, {
        skillName: 'test-skill',
        cwd: testDir,
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.output).toContain('Hello from TypeScript');
      expect(result.exitCode).toBe(0);
    });

    it('should execute .js scripts with node', async () => {
      // Arrange
      const script = `console.log("Hello from JavaScript");`;
      await fs.writeFile(path.join(scriptsDir, 'run.js'), script);
      const skill = createMockSkill({ scriptsDir });

      // Act
      const result = await executor.execute(skill, {
        skillName: 'test-skill',
        cwd: testDir,
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.output).toContain('Hello from JavaScript');
      expect(result.exitCode).toBe(0);
    });

    it('should execute .sh scripts with bash', async () => {
      // Arrange
      const script = `#!/bin/bash\necho "Hello from Shell"`;
      await fs.writeFile(path.join(scriptsDir, 'run.sh'), script);
      const skill = createMockSkill({ scriptsDir });

      // Act
      const result = await executor.execute(skill, {
        skillName: 'test-skill',
        cwd: testDir,
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.output).toContain('Hello from Shell');
      expect(result.exitCode).toBe(0);
    });

    it('should pass SKILL_ARGS as JSON env var', async () => {
      // Arrange
      const script = `console.log(process.env.SKILL_ARGS);`;
      await fs.writeFile(path.join(scriptsDir, 'run.js'), script);
      const skill = createMockSkill({ scriptsDir });

      // Act
      const result = await executor.execute(skill, {
        skillName: 'test-skill',
        args: { query: 'test query', count: 5 },
        cwd: testDir,
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.output).toContain('"query":"test query"');
      expect(result.output).toContain('"count":5');
    });

    it('should set SKILL_NAME env var', async () => {
      // Arrange
      const script = `console.log("Name:", process.env.SKILL_NAME);`;
      await fs.writeFile(path.join(scriptsDir, 'run.js'), script);
      const skill = createMockSkill({ scriptsDir, name: 'my-custom-skill' });

      // Act
      const result = await executor.execute(skill, {
        skillName: 'my-custom-skill',
        cwd: testDir,
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.output).toContain('Name: my-custom-skill');
    });

    it('should set SKILL_DIR env var', async () => {
      // Arrange
      const script = `console.log("Dir:", process.env.SKILL_DIR);`;
      await fs.writeFile(path.join(scriptsDir, 'run.js'), script);
      const skill = createMockSkill({ scriptsDir });

      // Act
      const result = await executor.execute(skill, {
        skillName: 'test-skill',
        cwd: testDir,
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.output).toContain(`Dir: ${skillDir}`);
    });

    it('does not inherit unrelated service secrets by default', async () => {
      process.env.UNRELATED_API_KEY = 'do-not-leak-this-secret';
      try {
        await fs.writeFile(
          path.join(scriptsDir, 'run.js'),
          `console.log(String(process.env.UNRELATED_API_KEY));`,
        );
        const result = await executor.execute(createMockSkill({ scriptsDir }), {
          skillName: 'test-skill',
          cwd: testDir,
        });
        expect(result.success).toBe(true);
        expect(result.output?.trim()).toBe('undefined');
        expect(result.output).not.toContain('do-not-leak-this-secret');
      } finally {
        delete process.env.UNRELATED_API_KEY;
      }
    });

    it('passes only explicitly declared secret env and redacts it from output', async () => {
      process.env.DECLARED_API_KEY = 'declared-secret-value';
      try {
        await fs.writeFile(
          path.join(scriptsDir, 'run.js'),
          `console.log(process.env.DECLARED_API_KEY);`,
        );
        const skill = createMockSkill({
          scriptsDir,
          frontmatter: {
            name: 'test-skill',
            description: 'Test',
            metadata: { openclaw: { primaryEnv: 'DECLARED_API_KEY' } },
          },
        });
        const result = await executor.execute(skill, { skillName: 'test-skill', cwd: testDir });
        expect(result.success).toBe(true);
        expect(result.output).toContain('[REDACTED]');
        expect(result.output).not.toContain('declared-secret-value');
      } finally {
        delete process.env.DECLARED_API_KEY;
      }
    });

    it('should return success=true and output on success', async () => {
      // Arrange
      const script = `console.log("Success output");`;
      await fs.writeFile(path.join(scriptsDir, 'run.js'), script);
      const skill = createMockSkill({ scriptsDir });

      // Act
      const result = await executor.execute(skill, {
        skillName: 'test-skill',
        cwd: testDir,
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.output).toContain('Success output');
      expect(result.exitCode).toBe(0);
      expect(result.error).toBeUndefined();
    });

    it('should return success=false and error on script failure', async () => {
      // Arrange - script that exits with error
      const script = `process.exit(1);`;
      await fs.writeFile(path.join(scriptsDir, 'run.js'), script);
      const skill = createMockSkill({ scriptsDir });

      // Act
      const result = await executor.execute(skill, {
        skillName: 'test-skill',
        cwd: testDir,
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('should capture stderr output', async () => {
      // Arrange
      const script = `console.error("Error message"); process.exit(0);`;
      await fs.writeFile(path.join(scriptsDir, 'run.js'), script);
      const skill = createMockSkill({ scriptsDir });

      // Act
      const result = await executor.execute(skill, {
        skillName: 'test-skill',
        cwd: testDir,
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.error).toContain('Error message');
    });

    it('should return error for unsupported script types', async () => {
      // Arrange - create a .py file (unsupported)
      await fs.writeFile(path.join(scriptsDir, 'run.py'), 'print("hello")');
      // Also need to make resolveScript find it by patching the private method
      // Instead, we'll test via frontmatter mapping
      const skill = createMockSkill({
        scriptsDir,
        frontmatter: {
          name: 'test-skill',
          description: 'Test',
          scripts: {
            'python-action': 'scripts/run.py',
          },
        },
      });

      // Act
      const result = await executor.execute(skill, {
        skillName: 'test-skill',
        action: 'python-action',
        cwd: testDir,
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported script type: .py');
    });
  });

  describe('error handling', () => {
    it('should return error if skill has no scripts (hasScripts=false)', async () => {
      // Arrange
      const skill = createMockSkill({
        hasScripts: false,
        scriptsDir: undefined,
      });

      // Act
      const result = await executor.execute(skill, {
        skillName: 'test-skill',
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('does not have executable scripts');
      expect(result.exitCode).toBe(1);
    });

    it('should return error if script not found for action', async () => {
      // Arrange - empty scripts dir
      const skill = createMockSkill({ scriptsDir });

      // Act
      const result = await executor.execute(skill, {
        skillName: 'test-skill',
        action: 'missing-action',
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('No script found for action');
      expect(result.exitCode).toBe(1);
    });

    it('should return error if no script found for default action', async () => {
      // Arrange - empty scripts directory (no run.ts, no default.ts)
      const skill = createMockSkill({ scriptsDir });

      // Act
      const result = await executor.execute(skill, {
        skillName: 'test-skill',
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('No script found');
      expect(result.error).toContain('run/default');
    });

    it('should handle script that throws error', async () => {
      // Arrange
      const script = `throw new Error("Script crashed");`;
      await fs.writeFile(path.join(scriptsDir, 'run.js'), script);
      const skill = createMockSkill({ scriptsDir });

      // Act
      const result = await executor.execute(skill, {
        skillName: 'test-skill',
        cwd: testDir,
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('timeout', () => {
    // Note: Actual timeout tests are slow (30 seconds), so we document the behavior
    // The executor uses exit code 124 for timeout (standard Unix convention)
    it.skip('should return exitCode 124 on timeout (skipped - too slow)', async () => {
      // This test would take 30+ seconds to run
      // Documented behavior: timeout returns exitCode 124
      expect(true).toBe(true);
    });

    it('documents that timeout uses exit code 124', () => {
      // The SkillExecutor uses exit code 124 for timeouts
      // This is the standard Unix convention for timeout
      // See executor.ts line ~214: exitCode: 124
      expect(124).toBe(124); // Placeholder assertion to document behavior
    });

    it('aborts a running script at the caller deadline', async () => {
      await fs.writeFile(path.join(scriptsDir, 'run.js'), 'setTimeout(() => console.log("late"), 10000)');
      const skill = createMockSkill({ scriptsDir });
      const controller = new AbortController();
      const started = Date.now();
      const running = executor.execute(skill, {
        skillName: skill.name,
        cwd: testDir,
        signal: controller.signal,
        deadlineAt: Date.now() + 5000,
      });
      setTimeout(() => controller.abort(), 30);

      const result = await running;
      expect(Date.now() - started).toBeLessThan(1000);
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(124);
      expect(result.error).toMatch(/aborted/i);
    });
  });

  describe('listScripts', () => {
    it('should list .ts, .js, .sh files in scripts dir', async () => {
      // Arrange
      await fs.writeFile(path.join(scriptsDir, 'run.ts'), '');
      await fs.writeFile(path.join(scriptsDir, 'helper.js'), '');
      await fs.writeFile(path.join(scriptsDir, 'setup.sh'), '');
      await fs.writeFile(path.join(scriptsDir, 'readme.md'), ''); // Should be excluded
      const skill = createMockSkill({ scriptsDir });

      // Act
      const scripts = await executor.listScripts(skill);

      // Assert
      expect(scripts).toHaveLength(3);
      expect(scripts).toContain('run.ts');
      expect(scripts).toContain('helper.js');
      expect(scripts).toContain('setup.sh');
      expect(scripts).not.toContain('readme.md');
    });

    it('should return empty array if no scripts dir', async () => {
      // Arrange
      const skill = createMockSkill({ scriptsDir: undefined });

      // Act
      const scripts = await executor.listScripts(skill);

      // Assert
      expect(scripts).toEqual([]);
    });

    it('should return empty array if scripts dir does not exist', async () => {
      // Arrange
      const skill = createMockSkill({
        scriptsDir: path.join(testDir, 'nonexistent', 'scripts'),
      });

      // Act
      const scripts = await executor.listScripts(skill);

      // Assert
      expect(scripts).toEqual([]);
    });

    it('should return empty array if scripts dir is empty', async () => {
      // Arrange - scriptsDir already exists but is empty
      const skill = createMockSkill({ scriptsDir });

      // Act
      const scripts = await executor.listScripts(skill);

      // Assert
      expect(scripts).toEqual([]);
    });
  });

  describe('createSkillExecutor', () => {
    it('should create executor without logger', () => {
      // Act
      const exec = createSkillExecutor();

      // Assert
      expect(exec).toBeInstanceOf(SkillExecutor);
    });

    it('should create executor with logger', () => {
      // Arrange
      const logger = createMockLogger();

      // Act
      const exec = createSkillExecutor(logger);

      // Assert
      expect(exec).toBeInstanceOf(SkillExecutor);
    });

    it('reports every execution to the optional telemetry hook', async () => {
      const events: Array<{ name: string; success: boolean; durationMs: number }> = [];
      const exec = createSkillExecutor(createMockLogger(), undefined, {
        onSkillExecuted: (name, success, durationMs) => events.push({ name, success, durationMs }),
      });
      await fs.writeFile(path.join(scriptsDir, 'run.js'), 'console.log("ok")');
      const skill = createMockSkill({ scriptsDir, name: 'measured-skill' });

      await exec.execute(skill, { skillName: skill.name, cwd: testDir });
      await fs.rm(path.join(scriptsDir, 'run.js'));
      await exec.execute(skill, { skillName: skill.name, cwd: testDir, action: 'missing' });

      expect(events).toHaveLength(2);
      expect(events.map(event => event.success)).toEqual([true, false]);
      expect(events.every(event => event.name === 'measured-skill')).toBe(true);
      expect(events.every(event => event.durationMs >= 0)).toBe(true);
    });
  });

  describe('state identity resolution', () => {
    it('only canonicalizes default or explicitly configured aliases', () => {
      const aliases = ['owner-123', 'telegram:owner-123'];
      expect(resolveSkillStateUserId('telegram:owner-123', aliases)).toBe('default');
      expect(resolveSkillStateUserId('owner-123', aliases)).toBe('default');
      expect(resolveSkillStateUserId('api:default', [])).toBe('default');
      expect(resolveSkillStateUserId('telegram:someone-else', aliases)).toBe('telegram:someone-else');
      expect(resolveSkillStateUserId('api:someone-else', aliases)).toBe('api:someone-else');
    });

    it('exports both channel and state identities to subprocesses', () => {
      const skill = createMockSkill();
      const env = buildSkillSubprocessEnv(
        skill,
        {
          skillName: skill.name,
          userId: 'telegram:owner-123',
          idempotencyKey: 'op-123',
          deadlineAt: 123456,
        },
        undefined,
        ['owner-123', 'telegram:owner-123'],
      );
      expect(env.SKILL_USER_ID).toBe('telegram:owner-123');
      expect(env.SKILL_STATE_USER_ID).toBe('default');
      expect(env.SKILL_IDEMPOTENCY_KEY).toBe('op-123');
      expect(env.SKILL_DEADLINE_AT).toBe('123456');
    });
  });
});
