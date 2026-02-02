/**
 * Media Understanding Module
 *
 * Provides unified processing for:
 * - Links/URLs: Fetch, parse, and extract content
 * - Images: Download and prepare for vision APIs
 * - PDFs: Extract text content
 * - Documents: Parse various text formats
 *
 * @example
 * ```typescript
 * import { MediaProcessor } from './media/index.js';
 *
 * const processor = new MediaProcessor();
 *
 * // Process a URL (auto-detects type)
 * const result = await processor.processUrl('https://example.com/article');
 *
 * // Process message with attachments
 * const { content, processedMedia } = await processor.processMessage(
 *   'Check out this link: https://example.com',
 *   [{ type: 'image', url: 'https://example.com/photo.jpg' }]
 * );
 * ```
 */

// Main processor
export { MediaProcessor, createMediaProcessor } from './processor.js';

// Types
export type {
  MediaType,
  MediaContent,
  ImageContent,
  PDFContent,
  LinkContent,
  VideoContent,
  AudioContent,
  DocumentContent,
  ProcessedMedia,
  MediaProcessingResult,
  MediaProcessorConfig,
  ClaudeImageBlock,
  ClaudeTextBlock,
  ClaudeContentBlock,
} from './types.js';

// Link processing
export { extractUrls, fetchLink, summarizeLinkContent } from './link.js';

// Image processing
export {
  fetchImage,
  processImageBuffer,
  toClaudeImageBlock,
  isImageUrl,
  detectImageType,
  hashImage,
  estimateImageTokens,
} from './image.js';

// Document processing
export {
  fetchPdf,
  processPdfBuffer,
  isPdfUrl,
  summarizePdfContent,
  isPdfParseAvailable,
  processTextDocument,
} from './document.js';
