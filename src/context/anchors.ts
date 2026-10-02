/**
 * Anchor index for lean compaction.
 *
 * Summaries paraphrase; anchors never do. Everything here is copied verbatim
 * from the compacted span by regex: commit SHAs, PR/issue references, file
 * paths, URLs, ids/uuids, email addresses and error lines. The model can then
 * quote an exact identifier after compaction instead of guessing one.
 */

export interface AnchorIndex {
  commits: string[];
  refs: string[];
  files: string[];
  urls: string[];
  ids: string[];
  emails: string[];
  /** ISO dates and date-like version strings (e.g. API versions 2025-09-03). */
  dates: string[];
  errors: string[];
  /** Short verbatim surroundings of ids/commits so the model can tell which id is which. */
  context?: Record<string, string>;
}

export type AnchorCategory = Exclude<keyof AnchorIndex, 'context'>;

/** A text fragment; weight > 1 marks high-signal text (user/assistant prose, tool inputs). */
export type AnchorFragment = string | { text: string; weight: number };

export const ANCHOR_CAPS: Record<AnchorCategory, number> = {
  commits: 30,
  refs: 30,
  files: 60,
  urls: 40,
  ids: 50,
  emails: 30,
  dates: 15,
  errors: 25,
};

const MAX_ANCHOR_CHARS = 200;

export function emptyAnchors(): AnchorIndex {
  return { commits: [], refs: [], files: [], urls: [], ids: [], emails: [], dates: [], errors: [] };
}

// Every repetition is bounded: tool output can hold multi-kilobyte runs of
// word characters, and unbounded `+` here is quadratic on them.
const URL_RE = /https?:\/\/[^\s<>"'`)\]}\\]{1,500}/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX32_RE = /\b[0-9a-f]{32}\b/gi;
const SHA_RE = /\b[0-9a-f]{7,40}\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,120}\.[A-Za-z]{2,24}\b/g;
const REF_RE = /(?:^|[\s(,[])(#\d{1,6})\b/g;
const PR_RE = /\b(?:PR|pull request|issue)\s*#?(\d{1,6})\b/gi;
const PATH_RE = /(?:~|\.{1,2})?\/?(?:[\w@.+-]{1,80}\/){1,12}[\w@.+-]{1,80}\.[A-Za-z0-9]{1,8}\b/g;
const BARE_FILE_RE = /\b[\w.+-]{1,80}\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|sh|ya?ml|toml|sql|db|txt|csv|html?|css|pdf|png|jpe?g|svg|env|lock|ini|cfg|conf|go|rs|java|kt|swift|rb|php|docx|xlsx|pptx)\b/g;
const KEYED_ID_RE = /\b(?:id|ID|Id|_id|uuid)["']?\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9_-]{5,63})/g;
const DATE_RE = /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g;
const ERROR_LINE_RE = /(?:\b\w*Error\b:|\bException\b|\bFAILED\b|error TS\d+|npm ERR!|Traceback \(most recent|\bfatal:|\bpanic:|ENOENT|EACCES|ECONNREFUSED)/;

/**
 * Scores every candidate by salience: each occurrence adds the fragment's
 * weight, so identifiers the conversation keeps using (in tool inputs and
 * prose) beat one-off noise such as per-response request ids. When a category
 * overflows its cap the highest-scoring values survive, then they are listed
 * in first-seen (newest-first) order.
 */
class AnchorCollector {
  private readonly scores: Record<AnchorCategory, Map<string, { score: number; order: number }>> = {
    commits: new Map(), refs: new Map(), files: new Map(), urls: new Map(),
    ids: new Map(), emails: new Map(), dates: new Map(), errors: new Map(),
  };
  private order = 0;
  /** Best context where the value was used (prose/tool input) and where it was produced (tool output). */
  private readonly contexts = new Map<string, { used?: string; seen?: string }>();

  add(category: AnchorCategory, value: string, weight: number, context?: string): void {
    const trimmed = value.trim().slice(0, MAX_ANCHOR_CHARS);
    if (!trimmed) return;
    const entry = this.scores[category].get(trimmed);
    if (entry) entry.score += weight;
    else this.scores[category].set(trimmed, { score: weight, order: this.order++ });
    if (context) {
      const slot = weight > 1 ? 'used' : 'seen';
      const current = this.contexts.get(trimmed) ?? {};
      const existing = current[slot];
      if (!existing || letterCount(context) > letterCount(existing)) {
        current[slot] = context;
        this.contexts.set(trimmed, current);
      }
    }
  }

  result(): AnchorIndex {
    const out = emptyAnchors();
    for (const category of Object.keys(ANCHOR_CAPS) as (AnchorCategory)[]) {
      out[category] = [...this.scores[category].entries()]
        .sort((a, b) => b[1].score - a[1].score || a[1].order - b[1].order)
        .slice(0, ANCHOR_CAPS[category])
        .sort((a, b) => a[1].order - b[1].order)
        .map(([value]) => value);
    }
    const context: Record<string, string> = {};
    for (const value of [...out.ids, ...out.commits]) {
      const found = this.contexts.get(value);
      const parts = [found?.seen, found?.used].filter((part): part is string => !!part);
      if (parts.length > 0) context[value] = [...new Set(parts)].join(' | ');
    }
    if (Object.keys(context).length > 0) out.context = context;
    return out;
  }
}

// JSON keys and shell boilerplate carry no meaning about which id is which.
const NOISE_WORD_RE = /\b(?:object|type|text|content|annotations|plain_text|href|link|null|false|true|id|curl|cat|config|api_key|NOTION_KEY|Authorization|Bearer|https?)\b/g;

function letterCount(text: string): number {
  return (text.replace(NOISE_WORD_RE, ' ').match(/[A-Za-z]{3,}/g) ?? []).join('').length;
}

const CONTEXT_BEFORE = 45;
const CONTEXT_AFTER = 90;

function cleanContext(text: string): string {
  return text
    .replace(/\\[nrt]/g, ' ')
    .replace(/[{}[\]"\\]+/g, ' ')
    .replace(/\b(?:type|object|text|content|plain_text)\s*:\s*/g, '')
    .replace(/\s+([:,])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Verbatim surroundings of a match, JSON punctuation removed. */
function contextAround(text: string, index: number, length: number): string {
  const before = cleanContext(text.slice(Math.max(0, index - CONTEXT_BEFORE), index));
  const after = cleanContext(text.slice(index + length, index + length + CONTEXT_AFTER));
  return `${before} ⟨…⟩ ${after}`.trim().slice(0, 120);
}

function blank(match: string): string {
  return ' '.repeat(match.length);
}

const TOKEN_SPLIT_RE = /[\s"'`,;()[\]{}<>|=]+/;
const MAX_TOKEN_CHARS = 300;

function shortTokens(text: string): string[] {
  return text.split(TOKEN_SPLIT_RE).filter(token => token.length > 2 && token.length <= MAX_TOKEN_CHARS);
}

function looksLikeSha(value: string): boolean {
  if (!(value.length >= 7 && value.length <= 12) && value.length !== 40) return false;
  return /[0-9]/.test(value) && /[a-f]/.test(value);
}

/**
 * Extract anchors from a list of text fragments. Fragments should be passed
 * newest first so that, when a category overflows its cap, the most recent
 * identifiers survive.
 */
export function extractAnchors(fragments: readonly AnchorFragment[]): AnchorIndex {
  const collector = new AnchorCollector();

  for (const raw of fragments) {
    const fragment = typeof raw === 'string' ? raw : raw.text;
    const weight = typeof raw === 'string' ? 1 : Math.max(0, raw.weight);
    if (!fragment) continue;
    const add = (category: AnchorCategory, value: string, at?: number) => collector.add(
      category, value, weight, at === undefined ? undefined : contextAround(fragment, at, value.length));
    let rest = fragment;

    for (const match of fragment.matchAll(URL_RE)) {
      add('urls', match[0].replace(/[.,;:!?]+$/, ''));
    }
    rest = rest.replace(URL_RE, blank);

    if (rest.includes('@')) {
      for (const token of shortTokens(rest)) {
        if (token.includes('@')) for (const match of token.matchAll(EMAIL_RE)) add('emails', match[0]);
      }
      rest = rest.replace(EMAIL_RE, blank);
    }

    // Replacements keep string length so match indices map onto `fragment`.
    for (const match of rest.matchAll(UUID_RE)) add('ids', match[0], match.index);
    rest = rest.replace(UUID_RE, blank);
    for (const match of rest.matchAll(HEX32_RE)) add('ids', match[0], match.index);
    rest = rest.replace(HEX32_RE, blank);

    for (const match of rest.matchAll(KEYED_ID_RE)) {
      const value = match[1];
      // Keyed ids must contain a digit or mixed case to avoid capturing words.
      if (/\d/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value))) {
        add('ids', value, (match.index ?? 0) + match[0].length - value.length);
      }
    }

    // Paths and file names never contain the separators below, so scan short
    // tokens only: long opaque runs (base64, minified blobs) are skipped.
    for (const token of shortTokens(rest)) {
      if (!token.includes('.')) continue;
      let remainder = token;
      if (token.includes('/')) {
        for (const match of token.matchAll(PATH_RE)) {
          const value = match[0];
          if (/^\d+(?:\/\d+)+/.test(value)) continue; // dates like 2024/01/02.x
          add('files', value);
        }
        remainder = token.replace(PATH_RE, ' ');
      }
      for (const match of remainder.matchAll(BARE_FILE_RE)) {
        if (/^\d/.test(match[0])) continue; // version numbers like 1.2.ts are noise
        add('files', match[0]);
      }
    }

    for (const match of rest.matchAll(SHA_RE)) {
      if (looksLikeSha(match[0])) add('commits', match[0], match.index);
    }

    for (const match of rest.matchAll(REF_RE)) add('refs', match[1]);
    for (const match of rest.matchAll(PR_RE)) add('refs', `#${match[1]}`);
    for (const match of rest.matchAll(DATE_RE)) add('dates', match[0]);

    for (const line of fragment.split('\n')) {
      if (ERROR_LINE_RE.test(line)) add('errors', line.replace(/\s+/g, ' '));
    }
  }

  return collector.result();
}

export function capAnchors(anchors: AnchorIndex): AnchorIndex {
  const out = emptyAnchors();
  for (const key of Object.keys(ANCHOR_CAPS) as (AnchorCategory)[]) {
    out[key] = (anchors[key] ?? []).slice(0, ANCHOR_CAPS[key]);
  }
  if (anchors.context) {
    const kept = new Set([...out.ids, ...out.commits]);
    const context = Object.fromEntries(Object.entries(anchors.context).filter(([value]) => kept.has(value)));
    if (Object.keys(context).length > 0) out.context = context;
  }
  return out;
}

/** Merge two indexes; `newer` wins ordering, duplicates are dropped, caps apply. */
export function mergeAnchors(newer: AnchorIndex, older: AnchorIndex | null | undefined): AnchorIndex {
  if (!older) return capAnchors(newer);
  const out = emptyAnchors();
  for (const key of Object.keys(ANCHOR_CAPS) as (AnchorCategory)[]) {
    out[key] = [...new Set([...(newer[key] ?? []), ...(older[key] ?? [])])];
  }
  out.context = { ...(older.context ?? {}), ...(newer.context ?? {}) };
  return capAnchors(out);
}

export function anchorCount(anchors: AnchorIndex): number {
  return (Object.keys(ANCHOR_CAPS) as AnchorCategory[]).reduce((sum, key) => sum + (anchors[key]?.length ?? 0), 0);
}

const LABELS: Record<AnchorCategory, string> = {
  commits: 'Commits',
  refs: 'PRs/issues',
  files: 'Files',
  urls: 'URLs',
  ids: 'IDs',
  emails: 'Emails',
  dates: 'Dates/versions',
  errors: 'Errors',
};

/** Render as a compact markdown block (empty string when there are no anchors). */
export function renderAnchors(anchors: AnchorIndex): string {
  const lines: string[] = [];
  for (const key of Object.keys(LABELS) as (AnchorCategory)[]) {
    const values = anchors[key] as string[] | undefined;
    if (!values?.length) continue;
    if (key === 'errors') {
      lines.push(`- ${LABELS[key]}:`);
      for (const value of values) lines.push(`  - ${value}`);
    } else if ((key === 'ids' || key === 'commits') && values.some(value => anchors.context?.[value])) {
      lines.push(`- ${LABELS[key]}:`);
      for (const value of values) {
        const context = anchors.context?.[value];
        lines.push(context ? `  - ${value} — ${context}` : `  - ${value}`);
      }
    } else {
      lines.push(`- ${LABELS[key]}: ${values.join(' · ')}`);
    }
  }
  return lines.join('\n');
}
