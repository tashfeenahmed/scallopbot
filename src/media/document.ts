/**
 * Document Understanding
 *
 * Processes PDFs and other documents to extract text content.
 * Uses pdf-parse for PDF extraction (optional dependency).
 */

import type { PDFContent, DocumentContent, MediaProcessingResult } from './types.js';
import { safeImport } from '../utils/dynamic-import.js';

/** Maximum PDF size (50MB) */
const MAX_PDF_SIZE = 50 * 1024 * 1024;

/** Maximum text extraction length */
const MAX_TEXT_LENGTH = 100000;

/** Default timeout for document fetching */
const DEFAULT_TIMEOUT = 60000;

// Dynamic import for optional pdf-parse dependency
let pdfParse: ((buffer: Buffer) => Promise<{
  text: string;
  numpages: number;
  info?: { Title?: string; Author?: string };
}>) | null = null;

/**
 * Load pdf-parse dependency
 */
async function loadPdfParse(): Promise<boolean> {
  if (pdfParse) return true;

  try {
    const module = await safeImport<{ default: typeof pdfParse }>('pdf-parse');
    if (module) {
      pdfParse = module.default;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if PDF parsing is available
 */
export async function isPdfParseAvailable(): Promise<boolean> {
  return loadPdfParse();
}

/**
 * Fetch and process a PDF from URL
 */
export async function fetchPdf(
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
        Accept: 'application/pdf',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    // Get the PDF data
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return processPdfBuffer(buffer, url);
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
 * Process PDF from buffer
 */
export async function processPdfBuffer(
  buffer: Buffer,
  source: string
): Promise<MediaProcessingResult> {
  const startTime = Date.now();

  try {
    // Check size
    if (buffer.length > MAX_PDF_SIZE) {
      return {
        success: false,
        error: `PDF too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (max ${MAX_PDF_SIZE / 1024 / 1024}MB)`,
      };
    }

    // Verify PDF magic bytes
    if (buffer[0] !== 0x25 || buffer[1] !== 0x50 || buffer[2] !== 0x44 || buffer[3] !== 0x46) {
      return {
        success: false,
        error: 'Not a valid PDF file',
      };
    }

    // Load pdf-parse
    const available = await loadPdfParse();
    if (!available || !pdfParse) {
      // Fallback: return basic info without text extraction
      return {
        success: true,
        media: {
          type: 'pdf',
          source,
          mimeType: 'application/pdf',
          size: buffer.length,
          text: '[PDF parsing unavailable - install pdf-parse package]',
          processedAt: new Date(),
        },
        processingTime: Date.now() - startTime,
      };
    }

    // Parse PDF
    const data = await pdfParse(buffer);

    // Truncate text if needed
    let text = data.text;
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH) + '\n\n[Content truncated...]';
    }

    // Clean up text
    text = cleanPdfText(text);

    const pdfContent: PDFContent = {
      type: 'pdf',
      source,
      mimeType: 'application/pdf',
      size: buffer.length,
      text,
      pageCount: data.numpages,
      title: data.info?.Title,
      author: data.info?.Author,
      processedAt: new Date(),
    };

    return {
      success: true,
      media: pdfContent,
      processingTime: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: `PDF parsing failed: ${(error as Error).message}`,
      processingTime: Date.now() - startTime,
    };
  }
}

/**
 * Clean up extracted PDF text
 */
function cleanPdfText(text: string): string {
  return text
    // Normalize line endings
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Remove excessive whitespace
    .replace(/[ \t]+/g, ' ')
    // Remove excessive newlines (more than 2 in a row)
    .replace(/\n{3,}/g, '\n\n')
    // Remove leading/trailing whitespace on each line
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    // Final trim
    .trim();
}

/**
 * Process a generic document (txt, md, etc.)
 */
export async function processTextDocument(
  content: string,
  source: string,
  format: string
): Promise<MediaProcessingResult> {
  const startTime = Date.now();

  try {
    // Truncate if needed
    let text = content;
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH) + '\n\n[Content truncated...]';
    }

    const docContent: DocumentContent = {
      type: 'document',
      source,
      mimeType: `text/${format}`,
      text,
      format,
      size: content.length,
      processedAt: new Date(),
    };

    return {
      success: true,
      media: docContent,
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
 * Check if a URL looks like a PDF
 */
export function isPdfUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return path.endsWith('.pdf');
  } catch {
    return false;
  }
}

/**
 * Summarize PDF content for context
 */
export function summarizePdfContent(pdf: PDFContent, maxLength = 3000): string {
  const parts: string[] = [];

  parts.push(`[PDF Document]`);

  if (pdf.title) {
    parts.push(`Title: ${pdf.title}`);
  }

  if (pdf.author) {
    parts.push(`Author: ${pdf.author}`);
  }

  if (pdf.pageCount) {
    parts.push(`Pages: ${pdf.pageCount}`);
  }

  parts.push(`Source: ${pdf.source}`);
  parts.push('');
  parts.push('Content:');

  const headerLength = parts.join('\n').length;
  const contentLength = maxLength - headerLength - 50;

  if (pdf.text.length > contentLength) {
    parts.push(pdf.text.slice(0, contentLength) + '...');
  } else {
    parts.push(pdf.text);
  }

  return parts.join('\n');
}
