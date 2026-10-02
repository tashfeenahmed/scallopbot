/**
 * Native `webfetch`: fetch a URL and return its text.
 *
 * No LLM in the path. The result is capped at 15k chars (head + tail); the
 * full text is saved to the session's tool-output dir and the path is given.
 */

import { BlockedUrlError, checkUrlIsPublic, safeFetch } from '../../security/url-safety.js';
import { capHeadTail, saveToolOutput } from '../tool-output.js';
import { unusableWebContentReason } from './content-quality.js';

export const WEBFETCH_CAP_CHARS = 15_000;
export const WEBFETCH_TIMEOUT_MS = 30_000;
/** Bodies above this are cut before HTML conversion (protects memory). */
const MAX_BODY_CHARS = 5_000_000;

export interface WebFetchDeps {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  checkUrl?: (url: string) => Promise<{ safe: boolean; reason?: string }>;
  timeoutMs?: number;
}

export interface WebFetchResult {
  success: boolean;
  output: string;
}

/** Simple HTML to text: drop script/style/nav, block tags to newlines, decode entities. */
export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(script|style|nav|header|footer|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|blockquote|pre|section|article|table|ul|ol|dd|dt)>/gi, '\n');
  text = text.replace(/<(br|hr)\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
  text = text.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).join('\n');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export async function webFetch(
  args: { url?: unknown; max_length?: unknown },
  ctx: { sessionId: string; signal?: AbortSignal },
  deps: WebFetchDeps = {},
): Promise<WebFetchResult> {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) return { success: false, output: 'Missing required parameter: url' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { success: false, output: `Invalid URL format: ${url}` };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { success: false, output: 'Only http and https URLs are supported' };
  }

  const verdict = await (deps.checkUrl ?? checkUrlIsPublic)(url);
  if (!verdict.safe) return { success: false, output: verdict.reason ?? 'URL is not public' };

  const cap = typeof args.max_length === 'number' && args.max_length > 0
    ? Math.min(Math.floor(args.max_length), WEBFETCH_CAP_CHARS)
    : WEBFETCH_CAP_CHARS;
  const timeoutMs = deps.timeoutMs ?? WEBFETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => controller.abort(new Error('turn deadline'));
  ctx.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await (deps.fetchImpl ?? safeFetch)(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ScallopBot/1.0; WebFetch)',
        Accept: 'text/html, application/json, text/plain, */*',
      },
    });
    const contentType = response.headers.get('content-type') || '';
    let body = await response.text();
    if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS);
    const text = /html|xml/i.test(contentType) || /^\s*<(?:!doctype|html)/i.test(body) ? htmlToText(body) : body;

    if (!response.ok) {
      const snippet = text.slice(0, 500);
      return { success: false, output: `HTTP ${response.status} ${response.statusText} for ${url}${snippet ? `\n\n${snippet}` : ''}` };
    }

    const unusable = unusableWebContentReason(text);
    if (unusable) return { success: false, output: `Fetched page is not usable source content: ${unusable} (${url})` };

    const header = `URL: ${response.url || url}\nstatus ${response.status}, ${contentType || 'unknown type'}, ${text.length} chars`;
    if (text.length <= cap) return { success: true, output: `${header}\n\n${text}` };

    let savedNote: string;
    try {
      const file = saveToolOutput(ctx.sessionId, 'webfetch', `URL: ${url}\n\n${text}`);
      savedNote = `full text saved to ${file} (use read_file with offset/limit to read more)`;
    } catch {
      savedNote = 'full text could not be saved';
    }
    return {
      success: true,
      output: `${header}; showing head+tail, ${savedNote}\n\n${capHeadTail(text, cap, 0.6, savedNote)}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof BlockedUrlError) return { success: false, output: msg };
    if (controller.signal.aborted) {
      return { success: false, output: `Request timed out after ${Math.round(timeoutMs / 1000)}s: ${url}` };
    }
    return { success: false, output: `Fetch failed: ${msg}` };
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onAbort);
  }
}
