/**
 * Link Understanding
 *
 * Fetches URLs and extracts readable content for the agent.
 * Handles HTML pages, converting them to clean text.
 */

import type { LinkContent, MediaProcessingResult } from './types.js';

/** Default configuration */
const DEFAULT_CONFIG = {
  maxContentLength: 50000,
  timeout: 30000,
  userAgent:
    'Mozilla/5.0 (compatible; LeanBot/1.0; +https://github.com/leanbot)',
};

/**
 * URL validation regex
 */
const URL_REGEX = /https?:\/\/[^\s<>\"{}|\\^`\[\]]+/gi;

/**
 * Extract URLs from text
 */
export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX);
  if (!matches) return [];

  // Deduplicate and validate
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const url of matches) {
    // Clean trailing punctuation that might have been captured
    const cleanUrl = url.replace(/[.,;:!?)]+$/, '');

    // Validate URL
    try {
      new URL(cleanUrl);
      if (!seen.has(cleanUrl)) {
        seen.add(cleanUrl);
        urls.push(cleanUrl);
      }
    } catch {
      // Invalid URL, skip
    }
  }

  return urls;
}

/**
 * Fetch and process a URL
 */
export async function fetchLink(
  url: string,
  config: Partial<typeof DEFAULT_CONFIG> = {}
): Promise<MediaProcessingResult> {
  const startTime = Date.now();
  const cfg = { ...DEFAULT_CONFIG, ...config };

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
    const timeoutId = setTimeout(() => controller.abort(), cfg.timeout);

    const response = await fetch(url, {
      headers: {
        'User-Agent': cfg.userAgent,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const contentType = response.headers.get('content-type') || '';

    // Handle different content types
    if (contentType.includes('application/json')) {
      const json = await response.json();
      const content = JSON.stringify(json, null, 2).slice(0, cfg.maxContentLength);

      return {
        success: true,
        media: {
          type: 'link',
          source: url,
          mimeType: 'application/json',
          title: 'JSON Response',
          content,
          processedAt: new Date(),
        },
        processingTime: Date.now() - startTime,
      };
    }

    if (contentType.includes('text/plain')) {
      const text = await response.text();
      return {
        success: true,
        media: {
          type: 'link',
          source: url,
          mimeType: 'text/plain',
          content: text.slice(0, cfg.maxContentLength),
          processedAt: new Date(),
        },
        processingTime: Date.now() - startTime,
      };
    }

    // Default: HTML processing
    const html = await response.text();
    const linkContent = parseHtml(html, url, cfg.maxContentLength);

    return {
      success: true,
      media: linkContent,
      processingTime: Date.now() - startTime,
    };
  } catch (error) {
    const err = error as Error;
    if (err.name === 'AbortError') {
      return {
        success: false,
        error: `Request timeout after ${cfg.timeout}ms`,
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
 * Parse HTML and extract readable content
 */
function parseHtml(html: string, url: string, maxLength: number): LinkContent {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : undefined;

  // Extract meta description
  const descMatch = html.match(
    /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i
  ) || html.match(
    /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i
  );
  const description = descMatch ? decodeHtmlEntities(descMatch[1].trim()) : undefined;

  // Extract Open Graph data
  const ogTitleMatch = html.match(
    /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i
  );
  const ogTitle = ogTitleMatch ? decodeHtmlEntities(ogTitleMatch[1]) : undefined;

  const ogDescMatch = html.match(
    /<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i
  );
  const ogDesc = ogDescMatch ? decodeHtmlEntities(ogDescMatch[1]) : undefined;

  const ogImageMatch = html.match(
    /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i
  );
  const ogImage = ogImageMatch ? ogImageMatch[1] : undefined;

  const siteNameMatch = html.match(
    /<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i
  );
  const siteName = siteNameMatch ? decodeHtmlEntities(siteNameMatch[1]) : undefined;

  // Extract article date
  const dateMatch = html.match(
    /<meta[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i
  ) || html.match(
    /<time[^>]*datetime=["']([^"']+)["']/i
  );
  const publishedDate = dateMatch ? dateMatch[1] : undefined;

  // Extract main content
  const content = extractMainContent(html, maxLength);

  return {
    type: 'link',
    source: url,
    mimeType: 'text/html',
    title: ogTitle || title,
    description: ogDesc || description,
    content,
    ogImage,
    siteName,
    publishedDate,
    processedAt: new Date(),
  };
}

/**
 * Extract main content from HTML
 */
function extractMainContent(html: string, maxLength: number): string {
  // Remove unwanted elements
  let content = html
    // Remove scripts
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    // Remove styles
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Remove comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Remove nav, header, footer, aside
    .replace(/<(nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, '')
    // Remove forms
    .replace(/<form[^>]*>[\s\S]*?<\/form>/gi, '')
    // Remove iframes
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '');

  // Try to find main content area
  const mainMatch =
    content.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
    content.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
    content.match(/<div[^>]*class=["'][^"']*content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) ||
    content.match(/<div[^>]*id=["']content["'][^>]*>([\s\S]*?)<\/div>/i);

  if (mainMatch) {
    content = mainMatch[1];
  }

  // Convert to text
  content = content
    // Add newlines for block elements
    .replace(/<(p|div|br|h[1-6]|li|tr)[^>]*>/gi, '\n')
    // Add bullet for list items
    .replace(/<li[^>]*>/gi, '\n- ')
    // Remove all remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    // Clean up whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();

  // Truncate if needed
  if (content.length > maxLength) {
    content = content.slice(0, maxLength) + '\n\n[Content truncated...]';
  }

  return content;
}

/**
 * Decode HTML entities
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));
}

/**
 * Summarize link content for context
 */
export function summarizeLinkContent(link: LinkContent, maxLength = 2000): string {
  const parts: string[] = [];

  if (link.title) {
    parts.push(`Title: ${link.title}`);
  }

  if (link.siteName) {
    parts.push(`Source: ${link.siteName}`);
  }

  if (link.publishedDate) {
    parts.push(`Published: ${link.publishedDate}`);
  }

  if (link.description) {
    parts.push(`Description: ${link.description}`);
  }

  parts.push(`URL: ${link.source}`);
  parts.push('');
  parts.push('Content:');

  const headerLength = parts.join('\n').length;
  const contentLength = maxLength - headerLength - 50;

  if (link.content.length > contentLength) {
    parts.push(link.content.slice(0, contentLength) + '...');
  } else {
    parts.push(link.content);
  }

  return parts.join('\n');
}
