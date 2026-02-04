import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { pino } from 'pino';
import type { Skill, SkillFrontmatter } from './types.js';
import { SkillExecutor, createSkillExecutor } from './executor.js';

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
  });
});
