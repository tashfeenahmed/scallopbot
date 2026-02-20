/**
 * WebFetch Skill Execution Script
 *
 * Fetches a URL and extracts text content from HTML.
 */

export {};

interface WebFetchArgs {
  url: string;
  max_length?: number;
}

interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

const DEFAULT_MAX_LENGTH = 50000;
const TIMEOUT_MS = 30000;

function outputResult(result: SkillResult): void {
  console.log(JSON.stringify(result));
  process.exit(result.success ? 0 : 1);
}

/**
 * Check if a hostname resolves to a private/internal IP.
 * Blocks SSRF to private networks.
 */
function isPrivateUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname;

    // Block obvious private IPs
    const privatePatterns = [
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^0\./,
      /^169\.254\./,  // Link-local
      /^::1$/,
      /^fc00:/i,
      /^fe80:/i,
      /^localhost$/i,
    ];

    for (const pattern of privatePatterns) {
      if (pattern.test(hostname)) return true;
    }

    return false;
  } catch {
    return true; // Block invalid URLs
  }
}

/**
 * Simple HTML to text conversion.
 * Strips script/style/nav, converts block tags to newlines, strips remaining tags.
 */
function htmlToText(html: string): string {
  let text = html;

  // Remove script, style, nav, header, footer tags and contents
  text = text.replace(/<(script|style|nav|header|footer|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Convert block-level tags to newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|blockquote|pre|section|article)>/gi, '\n');
  text = text.replace(/<(br|hr)\s*\/?>/gi, '\n');

  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));

  // Collapse whitespace
  text = text
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .join('\n');

  // Collapse multiple blank lines
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

async function main(): Promise<void> {
  const skillArgsJson = process.env.SKILL_ARGS;

  if (!skillArgsJson) {
    outputResult({ success: false, output: '', error: 'SKILL_ARGS environment variable not set', exitCode: 1 });
    return;
  }

  let args: WebFetchArgs;
  try {
    args = JSON.parse(skillArgsJson);
  } catch (e) {
    outputResult({ success: false, output: '', error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1 });
    return;
  }

  if (!args.url) {
    outputResult({ success: false, output: '', error: 'Missing required parameter: url', exitCode: 1 });
    return;
  }

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(args.url);
  } catch {
    outputResult({ success: false, output: '', error: 'Invalid URL format', exitCode: 1 });
    return;
  }

  // Only allow http/https
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    outputResult({ success: false, output: '', error: 'Only http and https URLs are supported', exitCode: 1 });
    return;
  }

  // SSRF protection
  if (isPrivateUrl(args.url)) {
    outputResult({ success: false, output: '', error: 'URL points to private/internal network (blocked for security)', exitCode: 1 });
    return;
  }

  const maxLength = Math.min(args.max_length || DEFAULT_MAX_LENGTH, 100000);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(args.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'SmartBot/1.0 (WebFetch Skill)',
        'Accept': 'text/html, application/json, text/plain, */*',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (!response.ok) {
      outputResult({
        success: false,
        output: '',
        error: `HTTP ${response.status}: ${response.statusText}`,
        exitCode: 1,
      });
      return;
    }

    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();

    let text: string;
    if (contentType.includes('text/html')) {
      text = htmlToText(body);
    } else {
      text = body;
    }

    // Truncate if needed
    if (text.length > maxLength) {
      text = text.slice(0, maxLength) + '\n\n... (truncated)';
    }

    outputResult({
      success: true,
      output: text,
      exitCode: 0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('abort')) {
      outputResult({ success: false, output: '', error: `Request timed out after ${TIMEOUT_MS / 1000}s`, exitCode: 1 });
    } else {
      outputResult({ success: false, output: '', error: `Fetch failed: ${msg}`, exitCode: 1 });
    }
  }
}

main();
