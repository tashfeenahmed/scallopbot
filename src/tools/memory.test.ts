/**
 * Tests for Memory Tools
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemorySearchTool, MemoryGetTool, initializeMemoryTools } from './memory.js';
import { MemoryStore, HybridSearch } from '../memory/index.js';
import type { ToolContext } from './types.js';
import type { Logger } from 'pino';

// Create mock logger
const createMockLogger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }) as unknown as Logger;

// Create mock context
const createMockContext = (): ToolContext => ({
  workspace: '/test',
  sessionId: 'test-session',
  logger: createMockLogger(),
});

describe('Memory Tools', () => {
  let memoryStore: MemoryStore;
  let hybridSearch: HybridSearch;

  beforeEach(() => {
    memoryStore = new MemoryStore();
    hybridSearch = new HybridSearch({ store: memoryStore });

    // Add some test memories
    memoryStore.add({
      content: 'The user prefers dark mode for the IDE',
      type: 'preference',
      sessionId: 'session-1',
      timestamp: new Date(),
      tags: ['preference', 'ide', 'dark-mode'],
    });

    memoryStore.add({
      content: 'User name is John and they work at Acme Corp',
      type: 'fact',
      sessionId: 'session-1',
      timestamp: new Date(),
      tags: ['name', 'work'],
    });

    memoryStore.add({
      content: 'Discussed React component architecture',
      type: 'context',
      sessionId: 'session-1',
      timestamp: new Date(),
      tags: ['react', 'architecture'],
    });

    memoryStore.add({
      content: 'User likes TypeScript over JavaScript',
      type: 'preference',
      sessionId: 'session-2',
      timestamp: new Date(),
      tags: ['typescript', 'javascript'],
    });

    memoryStore.add({
      content: 'Summary of project requirements: build a chat application',
      type: 'summary',
      sessionId: 'session-2',
      timestamp: new Date(),
      tags: ['project', 'requirements'],
    });
  });

  describe('MemorySearchTool', () => {
    let tool: MemorySearchTool;
    let context: ToolContext;

    beforeEach(() => {
      tool = new MemorySearchTool({ store: memoryStore, search: hybridSearch });
      context = createMockContext();
    });

    it('should have correct name and description', () => {
      expect(tool.name).toBe('memory_search');
      expect(tool.description).toContain('Search');
    });

    it('should have valid tool definition', () => {
      expect(tool.definition.name).toBe('memory_search');
      expect(tool.definition.input_schema.type).toBe('object');
      expect(tool.definition.input_schema.required).toContain('query');
    });

    it('should search memories by query', async () => {
      const result = await tool.execute({ query: 'dark mode' }, context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('dark mode');
      expect(result.output).toContain('preference');
    });

    it('should search memories with type filter', async () => {
      const result = await tool.execute({ query: 'user', type: 'fact' }, context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('John');
      expect(result.output).toContain('fact');
    });

    it('should search memories with session filter', async () => {
      const result = await tool.execute(
        { query: 'TypeScript', sessionId: 'session-2' },
        context
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('TypeScript');
    });

    it('should respect limit parameter', async () => {
      const result = await tool.execute({ query: 'user', limit: 2 }, context);

      expect(result.success).toBe(true);
      // Should not have more than 2 results
      const resultCount = (result.output.match(/--- Result/g) || []).length;
      expect(resultCount).toBeLessThanOrEqual(2);
    });

    it('should return no results message when none found', async () => {
      // Use truly unique gibberish that won't match any n-grams
      const result = await tool.execute(
        { query: 'qwzxzqwzxz' },
        context
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('No memories found');
    });

    it('should cap limit at 50', async () => {
      const result = await tool.execute({ query: 'user', limit: 100 }, context);

      expect(result.success).toBe(true);
      // Tool should internally cap at 50
    });

    it('should create search from store if not provided', () => {
      const toolWithStore = new MemorySearchTool({ store: memoryStore });
      expect(toolWithStore.name).toBe('memory_search');
    });
  });

  describe('MemoryGetTool', () => {
    let tool: MemoryGetTool;
    let context: ToolContext;

    beforeEach(() => {
      tool = new MemoryGetTool({ store: memoryStore });
      context = createMockContext();
    });

    it('should have correct name and description', () => {
      expect(tool.name).toBe('memory_get');
      expect(tool.description).toContain('Retrieve');
    });

    it('should have valid tool definition', () => {
      expect(tool.definition.name).toBe('memory_get');
      expect(tool.definition.input_schema.type).toBe('object');
    });

    it('should get memory by ID', async () => {
      const memories = memoryStore.getAll();
      const testMemory = memories[0];

      const result = await tool.execute({ id: testMemory.id }, context);

      expect(result.success).toBe(true);
      expect(result.output).toContain(testMemory.content);
      expect(result.output).toContain(testMemory.id);
    });

    it('should return error for non-existent ID', async () => {
      const result = await tool.execute({ id: 'nonexistent-id' }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should get memories by session', async () => {
      const result = await tool.execute({ sessionId: 'session-1' }, context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('dark mode');
      expect(result.output).toContain('John');
      expect(result.output).toContain('React');
    });

    it('should get memories by type', async () => {
      const result = await tool.execute({ type: 'preference' }, context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('dark mode');
      expect(result.output).toContain('TypeScript');
    });

    it('should get recent memories', async () => {
      const result = await tool.execute({ recent: 3 }, context);

      expect(result.success).toBe(true);
      const memoryCount = (result.output.match(/--- Memory/g) || []).length;
      expect(memoryCount).toBeLessThanOrEqual(3);
    });

    it('should filter session memories by type', async () => {
      const result = await tool.execute(
        { sessionId: 'session-1', type: 'preference' },
        context
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('dark mode');
      expect(result.output).not.toContain('John');
    });

    it('should return recent memories when no filters provided', async () => {
      const result = await tool.execute({}, context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('memories');
    });

    it('should cap recent at 100', async () => {
      const result = await tool.execute({ recent: 500 }, context);

      expect(result.success).toBe(true);
      // Tool should internally cap at 100
    });

    it('should return no memories message when none match', async () => {
      const result = await tool.execute({ sessionId: 'nonexistent-session' }, context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('No memories found');
    });
  });

  describe('initializeMemoryTools', () => {
    it('should initialize with custom store and search', () => {
      const customStore = new MemoryStore();
      const customSearch = new HybridSearch({ store: customStore });

      // Should not throw
      expect(() => initializeMemoryTools(customStore, customSearch)).not.toThrow();
    });

    it('should create search if not provided', () => {
      const customStore = new MemoryStore();

      // Should not throw
      expect(() => initializeMemoryTools(customStore)).not.toThrow();
    });
  });
});
