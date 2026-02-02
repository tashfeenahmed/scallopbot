import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { ToolContext } from './types.js';
import { pino } from 'pino';

// Create a test context helper
function createTestContext(workspace: string): ToolContext {
  return {
    workspace,
    sessionId: 'test-session',
    logger: pino({ level: 'silent' }),
  };
}

describe('ReadTool', () => {
  let testDir: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scallopbot-test-'));
    ctx = createTestContext(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should read file contents', async () => {
    const { ReadTool } = await import('./read.js');
    const tool = new ReadTool();

    const testFile = path.join(testDir, 'test.txt');
    await fs.writeFile(testFile, 'Hello, World!');

    const result = await tool.execute({ path: testFile }, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Hello, World!');
  });

  it('should read file with line range', async () => {
    const { ReadTool } = await import('./read.js');
    const tool = new ReadTool();

    const testFile = path.join(testDir, 'multiline.txt');
    await fs.writeFile(testFile, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5');

    const result = await tool.execute(
      { path: testFile, startLine: 2, endLine: 4 },
      ctx
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Line 2');
    expect(result.output).toContain('Line 3');
    expect(result.output).toContain('Line 4');
    expect(result.output).not.toContain('Line 1');
    expect(result.output).not.toContain('Line 5');
  });

  it('should handle non-existent file', async () => {
    const { ReadTool } = await import('./read.js');
    const tool = new ReadTool();

    const result = await tool.execute(
      { path: path.join(testDir, 'nonexistent.txt') },
      ctx
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should detect binary files', async () => {
    const { ReadTool } = await import('./read.js');
    const tool = new ReadTool();

    const binaryFile = path.join(testDir, 'binary.bin');
    await fs.writeFile(binaryFile, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));

    const result = await tool.execute({ path: binaryFile }, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toContain('binary');
  });

  it('should warn about large files', async () => {
    const { ReadTool } = await import('./read.js');
    const tool = new ReadTool();

    const largeFile = path.join(testDir, 'large.txt');
    // Create a file with many lines
    const lines = Array(1000).fill('This is a line of text').join('\n');
    await fs.writeFile(largeFile, lines);

    const result = await tool.execute({ path: largeFile }, ctx);

    expect(result.success).toBe(true);
    // Should still contain content
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('should have correct tool definition', async () => {
    const { ReadTool } = await import('./read.js');
    const tool = new ReadTool();

    expect(tool.name).toBe('read');
    expect(tool.definition.name).toBe('read');
    expect(tool.definition.input_schema.properties).toHaveProperty('path');
  });
});

describe('WriteTool', () => {
  let testDir: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scallopbot-test-'));
    ctx = createTestContext(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should write content to a new file', async () => {
    const { WriteTool } = await import('./write.js');
    const tool = new WriteTool();

    const testFile = path.join(testDir, 'new-file.txt');
    const content = 'New file content';

    const result = await tool.execute({ path: testFile, content }, ctx);

    expect(result.success).toBe(true);
    const written = await fs.readFile(testFile, 'utf-8');
    expect(written).toBe(content);
  });

  it('should overwrite existing file', async () => {
    const { WriteTool } = await import('./write.js');
    const tool = new WriteTool();

    const testFile = path.join(testDir, 'existing.txt');
    await fs.writeFile(testFile, 'Original content');

    const newContent = 'Updated content';
    const result = await tool.execute({ path: testFile, content: newContent }, ctx);

    expect(result.success).toBe(true);
    const written = await fs.readFile(testFile, 'utf-8');
    expect(written).toBe(newContent);
  });

  it('should create parent directories automatically', async () => {
    const { WriteTool } = await import('./write.js');
    const tool = new WriteTool();

    const testFile = path.join(testDir, 'nested', 'deep', 'file.txt');
    const content = 'Nested content';

    const result = await tool.execute({ path: testFile, content }, ctx);

    expect(result.success).toBe(true);
    const written = await fs.readFile(testFile, 'utf-8');
    expect(written).toBe(content);
  });

  it('should return success confirmation message', async () => {
    const { WriteTool } = await import('./write.js');
    const tool = new WriteTool();

    const testFile = path.join(testDir, 'confirm.txt');
    const result = await tool.execute({ path: testFile, content: 'test' }, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Successfully');
  });

  it('should have correct tool definition', async () => {
    const { WriteTool } = await import('./write.js');
    const tool = new WriteTool();

    expect(tool.name).toBe('write');
    expect(tool.definition.input_schema.properties).toHaveProperty('path');
    expect(tool.definition.input_schema.properties).toHaveProperty('content');
    expect(tool.definition.input_schema.required).toContain('path');
    expect(tool.definition.input_schema.required).toContain('content');
  });
});

describe('EditTool', () => {
  let testDir: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scallopbot-test-'));
    ctx = createTestContext(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should perform single find-and-replace', async () => {
    const { EditTool } = await import('./edit.js');
    const tool = new EditTool();

    const testFile = path.join(testDir, 'edit.txt');
    await fs.writeFile(testFile, 'Hello, World!');

    const result = await tool.execute(
      { path: testFile, find: 'World', replace: 'Universe' },
      ctx
    );

    expect(result.success).toBe(true);
    const content = await fs.readFile(testFile, 'utf-8');
    expect(content).toBe('Hello, Universe!');
  });

  it('should perform bulk replacements', async () => {
    const { EditTool } = await import('./edit.js');
    const tool = new EditTool();

    const testFile = path.join(testDir, 'bulk.txt');
    await fs.writeFile(testFile, 'foo bar foo baz foo');

    const result = await tool.execute(
      { path: testFile, find: 'foo', replace: 'qux', all: true },
      ctx
    );

    expect(result.success).toBe(true);
    const content = await fs.readFile(testFile, 'utf-8');
    expect(content).toBe('qux bar qux baz qux');
  });

  it('should handle file not found', async () => {
    const { EditTool } = await import('./edit.js');
    const tool = new EditTool();

    const result = await tool.execute(
      { path: path.join(testDir, 'nonexistent.txt'), find: 'a', replace: 'b' },
      ctx
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should handle pattern not found', async () => {
    const { EditTool } = await import('./edit.js');
    const tool = new EditTool();

    const testFile = path.join(testDir, 'nofind.txt');
    await fs.writeFile(testFile, 'Hello, World!');

    const result = await tool.execute(
      { path: testFile, find: 'xyz', replace: 'abc' },
      ctx
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should return diff-style output', async () => {
    const { EditTool } = await import('./edit.js');
    const tool = new EditTool();

    const testFile = path.join(testDir, 'diff.txt');
    await fs.writeFile(testFile, 'old text');

    const result = await tool.execute(
      { path: testFile, find: 'old', replace: 'new' },
      ctx
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('old');
    expect(result.output).toContain('new');
  });

  it('should have correct tool definition', async () => {
    const { EditTool } = await import('./edit.js');
    const tool = new EditTool();

    expect(tool.name).toBe('edit');
    expect(tool.definition.input_schema.properties).toHaveProperty('path');
    expect(tool.definition.input_schema.properties).toHaveProperty('find');
    expect(tool.definition.input_schema.properties).toHaveProperty('replace');
  });
});

describe('BashTool', () => {
  let testDir: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scallopbot-test-'));
    ctx = createTestContext(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should execute simple command', async () => {
    const { BashTool } = await import('./bash.js');
    const tool = new BashTool();

    const result = await tool.execute({ command: 'echo "Hello"' }, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Hello');
  });

  it('should capture stdout', async () => {
    const { BashTool } = await import('./bash.js');
    const tool = new BashTool();

    const result = await tool.execute({ command: 'ls -la' }, ctx);

    expect(result.success).toBe(true);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('should capture stderr', async () => {
    const { BashTool } = await import('./bash.js');
    const tool = new BashTool();

    const result = await tool.execute(
      { command: 'ls /nonexistent-directory-12345' },
      ctx
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should respect timeout', async () => {
    const { BashTool } = await import('./bash.js');
    const tool = new BashTool();

    const result = await tool.execute(
      { command: 'sleep 10', timeout: 100 },
      ctx
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('timeout');
  });

  it('should truncate large output', async () => {
    const { BashTool } = await import('./bash.js');
    const tool = new BashTool();

    // Generate output larger than 30KB
    const result = await tool.execute(
      { command: 'yes "test" | head -10000' },
      ctx
    );

    expect(result.success).toBe(true);
    // Output should be limited
    expect(result.output.length).toBeLessThanOrEqual(35000); // 30KB + some buffer for message
  });

  it('should run commands in workspace directory', async () => {
    const { BashTool } = await import('./bash.js');
    const tool = new BashTool();

    const result = await tool.execute({ command: 'pwd' }, ctx);

    expect(result.success).toBe(true);
    // On macOS, /var is a symlink to /private/var, so we check that the path ends correctly
    expect(result.output.trim()).toContain(path.basename(testDir));
  });

  it('should have correct tool definition', async () => {
    const { BashTool } = await import('./bash.js');
    const tool = new BashTool();

    expect(tool.name).toBe('bash');
    expect(tool.definition.input_schema.properties).toHaveProperty('command');
    expect(tool.definition.input_schema.required).toContain('command');
  });
});

describe('ToolRegistry', () => {
  it('should register and retrieve tools', async () => {
    const { ToolRegistryImpl } = await import('./registry.js');
    const { ReadTool } = await import('./read.js');

    const registry = new ToolRegistryImpl();
    const tool = new ReadTool();

    registry.registerTool(tool);

    expect(registry.getTool('read')).toBe(tool);
  });

  it('should return all tool definitions', async () => {
    const { ToolRegistryImpl } = await import('./registry.js');
    const { ReadTool } = await import('./read.js');
    const { WriteTool } = await import('./write.js');

    const registry = new ToolRegistryImpl();
    registry.registerTool(new ReadTool());
    registry.registerTool(new WriteTool());

    const definitions = registry.getToolDefinitions();

    expect(definitions).toHaveLength(2);
    expect(definitions.map((d) => d.name)).toContain('read');
    expect(definitions.map((d) => d.name)).toContain('write');
  });

  it('should return undefined for unregistered tool', async () => {
    const { ToolRegistryImpl } = await import('./registry.js');

    const registry = new ToolRegistryImpl();

    expect(registry.getTool('nonexistent')).toBeUndefined();
  });
});
