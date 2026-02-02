/**
 * Image Understanding
 *
 * Processes images for vision APIs (Claude, GPT-4V, etc.)
 * Handles downloading, resizing, and encoding.
 */

import { createHash } from 'crypto';
import type { ImageContent, MediaProcessingResult, ClaudeImageBlock } from './types.js';

/** Maximum image size for vision APIs (20MB) */
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

/** Supported image MIME types */
const SUPPORTED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/** Default timeout for image fetching */
const DEFAULT_TIMEOUT = 30000;

/**
 * Detect image type from buffer
 */
export function detectImageType(buffer: Buffer): string | null {
  // Check magic bytes
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'image/gif';
  }
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Fetch image from URL
 */
export async function fetchImage(
  url: string,
  timeout = DEFAULT_TIMEOUT
): Promise<MediaProcessingResult> {
  const startTime = Date.now();

  try {
    // Validate URL
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return {
        success: false,
        error: `Invalid protocol: ${parsedUrl.protocol}`,
      };
    }

    // Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'image/*',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    // Check content type
    const contentType = response.headers.get('content-type')?.split(';')[0].trim();

    // Get the image data
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Check size
    if (buffer.length > MAX_IMAGE_SIZE) {
      return {
        success: false,
        error: `Image too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (max ${MAX_IMAGE_SIZE / 1024 / 1024}MB)`,
      };
    }

    // Detect actual type from buffer
    const detectedType = detectImageType(buffer);
    const mimeType = detectedType || contentType || 'image/jpeg';

    if (!SUPPORTED_TYPES.has(mimeType)) {
      return {
        success: false,
        error: `Unsupported image type: ${mimeType}`,
      };
    }

    // Encode to base64
    const base64 = buffer.toString('base64');

    const imageContent: ImageContent = {
      type: 'image',
      source: url,
      mimeType,
      size: buffer.length,
      base64,
      url,
      processedAt: new Date(),
    };

    return {
      success: true,
      media: imageContent,
      processingTime: Date.now() - startTime,
    };
  } catch (error) {
    const err = error as Error;
    if (err.name === 'AbortError') {
      return {
        success: false,
        error: `Request timeout after ${timeout}ms`,
        processingTime: Date.now() - startTime,
      };
    }
    return {
      success: false,
      error: err.message,
      processingTime: Date.now() - startTime,
    };
  }
}

/**
 * Process image from buffer
 */
export function processImageBuffer(
  buffer: Buffer,
  source: string
): MediaProcessingResult {
  const startTime = Date.now();

  try {
    // Check size
    if (buffer.length > MAX_IMAGE_SIZE) {
      return {
        success: false,
        error: `Image too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`,
      };
    }

    // Detect type
    const mimeType = detectImageType(buffer);
    if (!mimeType) {
      return {
        success: false,
        error: 'Could not detect image type',
      };
    }

    if (!SUPPORTED_TYPES.has(mimeType)) {
      return {
        success: false,
        error: `Unsupported image type: ${mimeType}`,
      };
    }

    // Encode to base64
    const base64 = buffer.toString('base64');

    const imageContent: ImageContent = {
      type: 'image',
      source,
      mimeType,
      size: buffer.length,
      base64,
      processedAt: new Date(),
    };

    return {
      success: true,
      media: imageContent,
      processingTime: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
      processingTime: Date.now() - startTime,
    };
  }
}

/**
 * Convert ImageContent to Claude vision format
 */
export function toClaudeImageBlock(image: ImageContent): ClaudeImageBlock {
  if (image.base64) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mimeType || 'image/jpeg',
        data: image.base64,
      },
    };
  }

  if (image.url) {
    return {
      type: 'image',
      source: {
        type: 'url',
        media_type: image.mimeType || 'image/jpeg',
        url: image.url,
      },
    };
  }

  throw new Error('Image must have either base64 data or URL');
}

/**
 * Generate a hash for image deduplication
 */
export function hashImage(image: ImageContent): string {
  const data = image.base64 || image.url || image.source;
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/**
 * Check if a URL looks like an image
 */
export function isImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return (
      path.endsWith('.jpg') ||
      path.endsWith('.jpeg') ||
      path.endsWith('.png') ||
      path.endsWith('.gif') ||
      path.endsWith('.webp') ||
      path.includes('/image') ||
      parsed.host.includes('imgur') ||
      parsed.host.includes('i.redd.it') ||
      parsed.host.includes('pbs.twimg')
    );
  } catch {
    return false;
  }
}

/**
 * Estimate token cost for an image (Claude pricing)
 * Based on Claude's image token calculation
 */
export function estimateImageTokens(image: ImageContent): number {
  // Claude charges based on image size
  // Roughly 1 token per 750 bytes for images
  const size = image.size || (image.base64 ? image.base64.length * 0.75 : 0);
  return Math.ceil(size / 750);
}
