/**
 * Tests for Media Understanding Module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractUrls,
  fetchLink,
  summarizeLinkContent,
  isImageUrl,
  isPdfUrl,
  detectImageType,
  processImageBuffer,
  toClaudeImageBlock,
  estimateImageTokens,
} from './index.js';
import { MediaProcessor } from './processor.js';

describe('Link Processing', () => {
  describe('extractUrls', () => {
    it('should extract URLs from text', () => {
      const text = 'Check out https://example.com and http://test.org/page';
      const urls = extractUrls(text);

      expect(urls).toHaveLength(2);
      expect(urls).toContain('https://example.com');
      expect(urls).toContain('http://test.org/page');
    });

    it('should handle URLs with paths and query strings', () => {
      const text = 'Visit https://example.com/path/to/page?foo=bar&baz=qux';
      const urls = extractUrls(text);

      expect(urls).toHaveLength(1);
      expect(urls[0]).toBe('https://example.com/path/to/page?foo=bar&baz=qux');
    });

    it('should strip trailing punctuation', () => {
      const text = 'Go to https://example.com. Or https://test.org!';
      const urls = extractUrls(text);

      expect(urls).toContain('https://example.com');
      expect(urls).toContain('https://test.org');
    });

    it('should deduplicate URLs', () => {
      const text = 'https://example.com and https://example.com again';
      const urls = extractUrls(text);

      expect(urls).toHaveLength(1);
    });

    it('should return empty array for text with no URLs', () => {
      const text = 'No links here!';
      const urls = extractUrls(text);

      expect(urls).toHaveLength(0);
    });

    it('should ignore invalid URLs', () => {
      const text = 'Invalid: http:// and https://';
      const urls = extractUrls(text);

      expect(urls).toHaveLength(0);
    });
  });

  describe('fetchLink', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('should fetch and parse HTML page', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Test Page</title>
            <meta name="description" content="A test page">
          </head>
          <body>
            <main>
              <h1>Hello World</h1>
              <p>This is the main content.</p>
            </main>
          </body>
        </html>
      `;

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        headers: new Map([['content-type', 'text/html']]),
        text: () => Promise.resolve(html),
      });

      const result = await fetchLink('https://example.com');

      expect(result.success).toBe(true);
      expect(result.media?.type).toBe('link');
      expect((result.media as any).title).toBe('Test Page');
      expect((result.media as any).description).toBe('A test page');
      expect((result.media as any).content).toContain('Hello World');
    });

    it('should handle JSON responses', async () => {
      const json = { message: 'Hello', data: [1, 2, 3] };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve(json),
      });

      const result = await fetchLink('https://api.example.com/data');

      expect(result.success).toBe(true);
      expect(result.media?.type).toBe('link');
      expect((result.media as any).content).toContain('"message": "Hello"');
    });

    it('should handle HTTP errors', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const result = await fetchLink('https://example.com/missing');

      expect(result.success).toBe(false);
      expect(result.error).toContain('404');
    });

    it('should reject invalid protocols', async () => {
      const result = await fetchLink('ftp://example.com');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid protocol');
    });
  });

  describe('summarizeLinkContent', () => {
    it('should summarize link content', () => {
      const link = {
        type: 'link' as const,
        source: 'https://example.com',
        title: 'Test Article',
        siteName: 'Example Site',
        description: 'A great article',
        content: 'This is the full content of the article...',
        processedAt: new Date(),
      };

      const summary = summarizeLinkContent(link, 500);

      expect(summary).toContain('Title: Test Article');
      expect(summary).toContain('Source: Example Site');
      expect(summary).toContain('URL: https://example.com');
      expect(summary).toContain('This is the full content');
    });
  });
});

describe('Image Processing', () => {
  describe('isImageUrl', () => {
    it('should detect image URLs by extension', () => {
      expect(isImageUrl('https://example.com/photo.jpg')).toBe(true);
      expect(isImageUrl('https://example.com/photo.jpeg')).toBe(true);
      expect(isImageUrl('https://example.com/photo.png')).toBe(true);
      expect(isImageUrl('https://example.com/photo.gif')).toBe(true);
      expect(isImageUrl('https://example.com/photo.webp')).toBe(true);
    });

    it('should detect image hosting domains', () => {
      expect(isImageUrl('https://i.imgur.com/abc123')).toBe(true);
      expect(isImageUrl('https://i.redd.it/abc123')).toBe(true);
      expect(isImageUrl('https://pbs.twimg.com/media/abc')).toBe(true);
    });

    it('should reject non-image URLs', () => {
      expect(isImageUrl('https://example.com/page')).toBe(false);
      expect(isImageUrl('https://example.com/document.pdf')).toBe(false);
    });
  });

  describe('detectImageType', () => {
    it('should detect JPEG', () => {
      const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      expect(detectImageType(buffer)).toBe('image/jpeg');
    });

    it('should detect PNG', () => {
      const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      expect(detectImageType(buffer)).toBe('image/png');
    });

    it('should detect GIF', () => {
      const buffer = Buffer.from([0x47, 0x49, 0x46, 0x38]);
      expect(detectImageType(buffer)).toBe('image/gif');
    });

    it('should return null for unknown types', () => {
      const buffer = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      expect(detectImageType(buffer)).toBeNull();
    });
  });

  describe('processImageBuffer', () => {
    it('should process valid JPEG buffer', () => {
      // Minimal valid JPEG header
      const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

      const result = processImageBuffer(buffer, 'test.jpg');

      expect(result.success).toBe(true);
      expect(result.media?.type).toBe('image');
      expect((result.media as any).mimeType).toBe('image/jpeg');
      expect((result.media as any).base64).toBeDefined();
    });

    it('should reject unknown image types', () => {
      const buffer = Buffer.from([0x00, 0x00, 0x00, 0x00]);

      const result = processImageBuffer(buffer, 'unknown');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not detect');
    });

    it('should reject oversized images', () => {
      // Create a large buffer (mock)
      const largeBuffer = Buffer.alloc(25 * 1024 * 1024); // 25MB
      largeBuffer[0] = 0xff;
      largeBuffer[1] = 0xd8;
      largeBuffer[2] = 0xff;

      const result = processImageBuffer(largeBuffer, 'large.jpg');

      expect(result.success).toBe(false);
      expect(result.error).toContain('too large');
    });
  });

  describe('toClaudeImageBlock', () => {
    it('should convert base64 image to Claude format', () => {
      const image = {
        type: 'image' as const,
        source: 'test.jpg',
        mimeType: 'image/jpeg',
        base64: 'abc123',
        processedAt: new Date(),
      };

      const block = toClaudeImageBlock(image);

      expect(block.type).toBe('image');
      expect(block.source.type).toBe('base64');
      expect(block.source.media_type).toBe('image/jpeg');
      expect(block.source.data).toBe('abc123');
    });

    it('should convert URL image to Claude format', () => {
      const image = {
        type: 'image' as const,
        source: 'https://example.com/image.jpg',
        mimeType: 'image/jpeg',
        url: 'https://example.com/image.jpg',
        processedAt: new Date(),
      };

      const block = toClaudeImageBlock(image);

      expect(block.type).toBe('image');
      expect(block.source.type).toBe('url');
      expect(block.source.url).toBe('https://example.com/image.jpg');
    });
  });

  describe('estimateImageTokens', () => {
    it('should estimate tokens based on size', () => {
      const image = {
        type: 'image' as const,
        source: 'test.jpg',
        size: 750000, // 750KB
        processedAt: new Date(),
      };

      const tokens = estimateImageTokens(image);

      expect(tokens).toBe(1000); // 750000 / 750 = 1000
    });
  });
});

describe('PDF Processing', () => {
  describe('isPdfUrl', () => {
    it('should detect PDF URLs', () => {
      expect(isPdfUrl('https://example.com/document.pdf')).toBe(true);
      expect(isPdfUrl('https://example.com/DOCUMENT.PDF')).toBe(true);
    });

    it('should reject non-PDF URLs', () => {
      expect(isPdfUrl('https://example.com/page')).toBe(false);
      expect(isPdfUrl('https://example.com/image.jpg')).toBe(false);
    });
  });
});

describe('MediaProcessor', () => {
  let processor: MediaProcessor;

  beforeEach(() => {
    processor = new MediaProcessor();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('processUrl', () => {
    it('should auto-detect and process link', async () => {
      const html = '<html><head><title>Test</title></head><body>Content</body></html>';

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        headers: new Map([['content-type', 'text/html']]),
        text: () => Promise.resolve(html),
      });

      const result = await processor.processUrl('https://example.com/page');

      expect(result.success).toBe(true);
      expect(result.media?.type).toBe('link');
    });

    it('should cache processed URLs', async () => {
      const html = '<html><head><title>Test</title></head><body>Content</body></html>';

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        headers: new Map([['content-type', 'text/html']]),
        text: () => Promise.resolve(html),
      });

      await processor.processUrl('https://example.com/page');
      await processor.processUrl('https://example.com/page');

      // Should only fetch once
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('processTextUrls', () => {
    it('should extract and process multiple URLs', async () => {
      const html = '<html><head><title>Test</title></head><body>Content</body></html>';

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        headers: new Map([['content-type', 'text/html']]),
        text: () => Promise.resolve(html),
      });

      const text = 'Check https://example.com and https://test.org';
      const results = await processor.processTextUrls(text);

      expect(results.size).toBe(2);
      expect(results.get('https://example.com')?.success).toBe(true);
      expect(results.get('https://test.org')?.success).toBe(true);
    });
  });

  describe('buildClaudeContent', () => {
    it('should build content blocks with text and images', () => {
      const image = {
        type: 'image' as const,
        source: 'test.jpg',
        mimeType: 'image/jpeg',
        base64: 'abc123',
        processedAt: new Date(),
      };

      const link = {
        type: 'link' as const,
        source: 'https://example.com',
        title: 'Test',
        content: 'Link content',
        processedAt: new Date(),
      };

      const blocks = processor.buildClaudeContent('Hello', [image, link]);

      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe('image');
      expect(blocks[1].type).toBe('text');
      expect((blocks[1] as any).text).toContain('Hello');
      expect((blocks[1] as any).text).toContain('Link content');
    });
  });

  describe('getStatus', () => {
    it('should return capability status', async () => {
      const status = await processor.getStatus();

      expect(status.imageProcessing).toBe(true);
      expect(status.linkProcessing).toBe(true);
      expect(typeof status.pdfParsing).toBe('boolean');
    });
  });

  describe('cache management', () => {
    it('should clear cache', async () => {
      const html = '<html><title>Test</title></html>';

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        headers: new Map([['content-type', 'text/html']]),
        text: () => Promise.resolve(html),
      });

      await processor.processUrl('https://example.com');
      expect(processor.getCacheStats().size).toBe(1);

      processor.clearCache();
      expect(processor.getCacheStats().size).toBe(0);
    });
  });
});
