/**
 * Media Processor
 *
 * Unified processor for all media types: links, images, PDFs.
 * Automatically detects content type and processes accordingly.
 */

import type { Logger } from 'pino';
import type {
  MediaProcessorConfig,
  MediaProcessingResult,
  ProcessedMedia,
  ImageContent,
  LinkContent,
  PDFContent,
  ClaudeContentBlock,
} from './types.js';
import { extractUrls, fetchLink, summarizeLinkContent } from './link.js';
import { fetchImage, processImageBuffer, toClaudeImageBlock, isImageUrl } from './image.js';
import { fetchPdf, processPdfBuffer, isPdfUrl, summarizePdfContent, isPdfParseAvailable } from './document.js';
import type { Attachment } from '../channels/types.js';

/** Default configuration */
const DEFAULT_CONFIG: MediaProcessorConfig = {
  maxLinkContentLength: 50000,
  maxImageSize: 20 * 1024 * 1024,
  maxPDFSize: 50 * 1024 * 1024,
  userAgent: 'Mozilla/5.0 (compatible; LeanBot/1.0)',
  timeout: 30000,
  extractPDFImages: false,
};

/**
 * Media Processor
 *
 * Processes various media types and prepares them for the agent.
 */
export class MediaProcessor {
  private config: MediaProcessorConfig;
  private logger: Logger | null;
  private processedCache: Map<string, ProcessedMedia> = new Map();

  constructor(config: Partial<MediaProcessorConfig> = {}, logger?: Logger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger?.child({ module: 'media-processor' }) || null;
  }

  /**
   * Process a URL (auto-detect type)
   */
  async processUrl(url: string): Promise<MediaProcessingResult> {
    // Check cache
    const cached = this.processedCache.get(url);
    if (cached) {
      return { success: true, media: cached };
    }

    this.logger?.debug({ url }, 'Processing URL');

    let result: MediaProcessingResult;

    // Detect type and process
    if (isPdfUrl(url)) {
      result = await fetchPdf(url, this.config.timeout);
    } else if (isImageUrl(url)) {
      result = await fetchImage(url, this.config.timeout);
    } else {
      // Default to link processing
      result = await fetchLink(url, {
        maxContentLength: this.config.maxLinkContentLength,
        timeout: this.config.timeout,
        userAgent: this.config.userAgent,
      });
    }

    // Cache successful results
    if (result.success && result.media) {
      this.processedCache.set(url, result.media);
    }

    this.logger?.debug(
      { url, success: result.success, type: result.media?.type },
      'URL processed'
    );

    return result;
  }

  /**
   * Process an attachment from a channel
   */
  async processAttachment(attachment: Attachment): Promise<MediaProcessingResult> {
    this.logger?.debug({ type: attachment.type, filename: attachment.filename }, 'Processing attachment');

    switch (attachment.type) {
      case 'image':
        if (attachment.data) {
          return processImageBuffer(attachment.data, attachment.filename || 'image');
        }
        if (attachment.url) {
          return fetchImage(attachment.url, this.config.timeout);
        }
        return { success: false, error: 'Image attachment has no data or URL' };

      case 'file':
        // Check if it's a PDF
        if (
          attachment.mimeType === 'application/pdf' ||
          attachment.filename?.toLowerCase().endsWith('.pdf')
        ) {
          if (attachment.data) {
            return processPdfBuffer(attachment.data, attachment.filename || 'document.pdf');
          }
          if (attachment.url) {
            return fetchPdf(attachment.url, this.config.timeout);
          }
        }
        // Other file types - return as-is with note
        return {
          success: true,
          media: {
            type: 'document',
            source: attachment.filename || 'file',
            mimeType: attachment.mimeType,
            text: `[File attachment: ${attachment.filename || 'unknown'}, type: ${attachment.mimeType || 'unknown'}]`,
            format: attachment.mimeType?.split('/')[1] || 'unknown',
            size: attachment.size,
            processedAt: new Date(),
          },
        };

      case 'voice':
      case 'audio':
        // Audio is handled by voice module, just acknowledge
        return {
          success: true,
          media: {
            type: 'audio',
            source: attachment.filename || 'audio',
            mimeType: attachment.mimeType,
            duration: undefined,
            processedAt: new Date(),
          },
        };

      case 'video':
        // Video - return metadata only
        return {
          success: true,
          media: {
            type: 'video',
            source: attachment.filename || 'video',
            mimeType: attachment.mimeType,
            size: attachment.size,
            processedAt: new Date(),
          },
        };

      default:
        return { success: false, error: `Unknown attachment type: ${attachment.type}` };
    }
  }

  /**
   * Extract and process all URLs from text
   */
  async processTextUrls(text: string): Promise<Map<string, MediaProcessingResult>> {
    const urls = extractUrls(text);
    const results = new Map<string, MediaProcessingResult>();

    // Process URLs in parallel (with limit)
    const batchSize = 3;
    for (let i = 0; i < urls.length; i += batchSize) {
      const batch = urls.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (url) => ({
          url,
          result: await this.processUrl(url),
        }))
      );

      for (const { url, result } of batchResults) {
        results.set(url, result);
      }
    }

    return results;
  }

  /**
   * Build Claude-compatible content blocks from processed media
   */
  buildClaudeContent(
    text: string,
    media: ProcessedMedia[]
  ): ClaudeContentBlock[] {
    const blocks: ClaudeContentBlock[] = [];

    // Add images first (Claude vision API format)
    for (const item of media) {
      if (item.type === 'image') {
        try {
          blocks.push(toClaudeImageBlock(item as ImageContent));
        } catch (error) {
          this.logger?.warn({ error: (error as Error).message }, 'Failed to add image block');
        }
      }
    }

    // Build text content with link/PDF summaries
    const textParts: string[] = [text];

    for (const item of media) {
      if (item.type === 'link') {
        textParts.push('');
        textParts.push('---');
        textParts.push(summarizeLinkContent(item as LinkContent, 3000));
      } else if (item.type === 'pdf') {
        textParts.push('');
        textParts.push('---');
        textParts.push(summarizePdfContent(item as PDFContent, 5000));
      } else if (item.type === 'document') {
        textParts.push('');
        textParts.push('---');
        textParts.push(`[Document: ${item.source}]`);
        textParts.push(item.text.slice(0, 3000));
      } else if (item.type === 'video') {
        textParts.push('');
        textParts.push(`[Video attachment: ${item.source}]`);
      }
    }

    blocks.push({
      type: 'text',
      text: textParts.join('\n'),
    });

    return blocks;
  }

  /**
   * Process message with all attachments and embedded URLs
   */
  async processMessage(
    text: string,
    attachments: Attachment[] = []
  ): Promise<{
    content: ClaudeContentBlock[];
    processedMedia: ProcessedMedia[];
    errors: string[];
  }> {
    const processedMedia: ProcessedMedia[] = [];
    const errors: string[] = [];

    // Process attachments
    for (const attachment of attachments) {
      const result = await this.processAttachment(attachment);
      if (result.success && result.media) {
        processedMedia.push(result.media);
      } else if (result.error) {
        errors.push(`Attachment ${attachment.filename || attachment.type}: ${result.error}`);
      }
    }

    // Extract and process URLs from text
    const urlResults = await this.processTextUrls(text);
    for (const [url, result] of urlResults) {
      if (result.success && result.media) {
        processedMedia.push(result.media);
      } else if (result.error) {
        errors.push(`URL ${url}: ${result.error}`);
      }
    }

    // Build Claude content blocks
    const content = this.buildClaudeContent(text, processedMedia);

    return { content, processedMedia, errors };
  }

  /**
   * Get status of media processing capabilities
   */
  async getStatus(): Promise<{
    pdfParsing: boolean;
    imageProcessing: boolean;
    linkProcessing: boolean;
  }> {
    return {
      pdfParsing: await isPdfParseAvailable(),
      imageProcessing: true, // Always available
      linkProcessing: true, // Always available
    };
  }

  /**
   * Clear the processing cache
   */
  clearCache(): void {
    this.processedCache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; urls: string[] } {
    return {
      size: this.processedCache.size,
      urls: Array.from(this.processedCache.keys()),
    };
  }
}

/**
 * Create a media processor with default configuration
 */
export function createMediaProcessor(
  config?: Partial<MediaProcessorConfig>,
  logger?: Logger
): MediaProcessor {
  return new MediaProcessor(config, logger);
}
