/**
 * Media Understanding Types
 *
 * Types for processing images, PDFs, links, and other media content.
 */

/**
 * Supported media types
 */
export type MediaType = 'image' | 'pdf' | 'link' | 'video' | 'audio' | 'document';

/**
 * Base media content
 */
export interface MediaContent {
  type: MediaType;
  /** Original source URL or file path */
  source: string;
  /** MIME type if known */
  mimeType?: string;
  /** File size in bytes */
  size?: number;
  /** Processing timestamp */
  processedAt?: Date;
}

/**
 * Image content for vision APIs
 */
export interface ImageContent extends MediaContent {
  type: 'image';
  /** Base64 encoded image data */
  base64?: string;
  /** Image URL for URL-based vision APIs */
  url?: string;
  /** Image dimensions if known */
  width?: number;
  height?: number;
  /** Alt text or caption if available */
  altText?: string;
}

/**
 * PDF content
 */
export interface PDFContent extends MediaContent {
  type: 'pdf';
  /** Extracted text content */
  text: string;
  /** Number of pages */
  pageCount?: number;
  /** Title from metadata */
  title?: string;
  /** Author from metadata */
  author?: string;
}

/**
 * Link content
 */
export interface LinkContent extends MediaContent {
  type: 'link';
  /** Page title */
  title?: string;
  /** Meta description */
  description?: string;
  /** Extracted main content (cleaned) */
  content: string;
  /** Open Graph image URL */
  ogImage?: string;
  /** Site name */
  siteName?: string;
  /** Publish date if available */
  publishedDate?: string;
}

/**
 * Video content (metadata only, not processed)
 */
export interface VideoContent extends MediaContent {
  type: 'video';
  /** Video title */
  title?: string;
  /** Duration in seconds */
  duration?: number;
  /** Thumbnail URL */
  thumbnail?: string;
}

/**
 * Audio content
 */
export interface AudioContent extends MediaContent {
  type: 'audio';
  /** Transcription text */
  transcription?: string;
  /** Duration in seconds */
  duration?: number;
}

/**
 * Generic document content
 */
export interface DocumentContent extends MediaContent {
  type: 'document';
  /** Extracted text content */
  text: string;
  /** Document format */
  format?: string;
}

/**
 * Union of all media content types
 */
export type ProcessedMedia =
  | ImageContent
  | PDFContent
  | LinkContent
  | VideoContent
  | AudioContent
  | DocumentContent;

/**
 * Media processing result
 */
export interface MediaProcessingResult {
  success: boolean;
  media?: ProcessedMedia;
  error?: string;
  /** Processing time in ms */
  processingTime?: number;
}

/**
 * Media processor configuration
 */
export interface MediaProcessorConfig {
  /** Maximum content length for links (default: 50000 chars) */
  maxLinkContentLength?: number;
  /** Maximum image size in bytes (default: 20MB) */
  maxImageSize?: number;
  /** Maximum PDF size in bytes (default: 50MB) */
  maxPDFSize?: number;
  /** User agent for fetching links */
  userAgent?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Whether to extract images from PDFs */
  extractPDFImages?: boolean;
}

/**
 * Claude vision content block
 */
export interface ClaudeImageBlock {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type: string;
    data?: string;
    url?: string;
  };
}

/**
 * Claude text content block
 */
export interface ClaudeTextBlock {
  type: 'text';
  text: string;
}

/**
 * Claude content block union
 */
export type ClaudeContentBlock = ClaudeImageBlock | ClaudeTextBlock;
