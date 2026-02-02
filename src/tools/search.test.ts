import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BraveSearchTool, initializeBraveSearch } from './search.js';
import type { ToolContext } from './types.js';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('BraveSearchTool', () => {
  let tool: BraveSearchTool;
  let mockContext: ToolContext;

  beforeEach(() => {
    tool = new BraveSearchTool({ apiKey: 'test-api-key' });
    mockContext = {
      workspace: '/test',
      sessionId: 'test-session',
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
      } as any,
    };
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('definition', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe('web_search');
    });

    it('should have input schema with required query', () => {
      expect(tool.definition.input_schema.required).toContain('query');
    });
  });

  describe('execute', () => {
    it('should return error when query is empty', async () => {
      const result = await tool.execute({ query: '' }, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should return search results on success', async () => {
      const mockResponse = {
        web: {
          results: [
            {
              title: 'Test Result 1',
              url: 'https://example.com/1',
              description: 'This is test result 1',
              age: '1 day ago',
            },
            {
              title: 'Test Result 2',
              url: 'https://example.com/2',
              description: 'This is test result 2',
            },
          ],
        },
        query: {
          original: 'test query',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await tool.execute({ query: 'test query' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.output).toContain('Test Result 1');
      expect(result.output).toContain('https://example.com/1');
      expect(result.output).toContain('1 day ago');
      expect(result.output).toContain('Test Result 2');
    });

    it('should handle API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const result = await tool.execute({ query: 'test' }, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('401');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await tool.execute({ query: 'test' }, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });

    it('should include freshness parameter when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ web: { results: [] } }),
      });

      await tool.execute({ query: 'test', freshness: 'pd' }, mockContext);

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('freshness=pd');
    });

    it('should limit count to 20', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ web: { results: [] } }),
      });

      await tool.execute({ query: 'test', count: 100 }, mockContext);

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('count=20');
    });

    it('should include news results if present', async () => {
      const mockResponse = {
        web: {
          results: [
            { title: 'Web Result', url: 'https://example.com', description: 'Web desc' },
          ],
        },
        news: {
          results: [
            { title: 'News Story', url: 'https://news.com', description: 'News desc', age: '2 hours ago' },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await tool.execute({ query: 'test' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.output).toContain('[NEWS] News Story');
    });
  });

  describe('initializeBraveSearch', () => {
    it('should return null when API key not set', () => {
      const originalEnv = process.env.BRAVE_SEARCH_API_KEY;
      delete process.env.BRAVE_SEARCH_API_KEY;

      const result = initializeBraveSearch();
      expect(result).toBeNull();

      if (originalEnv) {
        process.env.BRAVE_SEARCH_API_KEY = originalEnv;
      }
    });

    it('should return tool when API key is set', () => {
      process.env.BRAVE_SEARCH_API_KEY = 'test-key';

      const result = initializeBraveSearch();
      expect(result).toBeInstanceOf(BraveSearchTool);

      delete process.env.BRAVE_SEARCH_API_KEY;
    });
  });
});
