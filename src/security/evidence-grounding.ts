import { createHash } from 'node:crypto';

/** Keep receipts small even when a tool returns a very large payload. */
export const MAX_EVIDENCE_CLAIM_DIGESTS = 96;
const MAX_EVIDENCE_SCAN_CHARS = 256 * 1024;
const CLAIM_DOMAIN = 'scallop-evidence-claim:v2:';
const PROVENANCE_DOMAIN = 'scallop-evidence-provenance:v1:';
const SHA256_RE = /^[a-f0-9]{64}$/i;

/**
 * General-purpose tools can faithfully report whatever text the model asked
 * them to produce, but that does not make the text an authoritative source.
 * These tools are therefore never eligible for unattended factual evidence,
 * even if a task (or a generated skill file) labels them as required.
 */
export const NEVER_AUTHORITATIVE_EVIDENCE_TOOLS = new Set([
  'bash', 'shell', 'run_code', 'python', 'node',
  'memory_search', 'read_file', 'write_file', 'edit_file', 'multi_edit',
  'apply_patch', 'grep', 'glob', 'ls', 'codesearch',
  'board', 'goals', 'reminder', 'triggers', 'progress', 'question',
  'telegram_send', 'send_message', 'spawn_agent',
]);

export type EvidenceAuthority = 'authoritative' | 'untrusted';

export interface EvidenceExecutionContext {
  /** Digest of the exact scheduler request this tool run belongs to. */
  taskRequestDigest: string;
  /** Digest of the durable owner/account scope for that request. */
  accountScopeDigest: string;
}

export interface EvidenceSourceDeclaration {
  /** Must be explicitly declared by an installed skill; default is false. */
  authoritative?: boolean;
  /** Stable public source identifier, e.g. `youtube-data-api:v3`. */
  source?: string;
}

export interface EvidenceProvenanceReceipt {
  authority?: EvidenceAuthority;
  /** Installed skill/source identity, never raw credentials or account IDs. */
  sourceDigest?: string;
  /** Exact tool arguments used to retrieve the source data. */
  toolRequestDigest?: string;
  /** Scheduler request that authorized this unattended run. */
  taskRequestDigest?: string;
  /** Durable owner/account scope of the unattended run. */
  accountScopeDigest?: string;
}

export interface EvidenceClaimLedger {
  claimDigests: string[];
  claimLedgerTruncated: boolean;
}

export interface EvidenceClaimReceipt {
  claimDigests?: readonly string[];
  claimLedgerTruncated?: boolean;
}

export interface AuthoritativeEvidenceReceipt extends EvidenceClaimReceipt, EvidenceProvenanceReceipt {
  toolName: string;
  success: boolean;
  completedAt: number;
  outputDigest: string;
  outputBytes: number;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};
const MONTH_PATTERN = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');

/** Canonical analytics/business metrics; order keeps specific phrases first. */
const METRIC_ALIASES: Array<{ canonical: string; pattern: string }> = [
  { canonical: 'view_duration', pattern: '(?:average\\s+)?view\\s+duration' },
  { canonical: 'watch_time', pattern: 'watch\\s+time' },
  { canonical: 'click_through_rate', pattern: 'click[-\\s]?through\\s+rate|ctr' },
  { canonical: 'conversion_rate', pattern: 'conversion\\s+rate' },
  { canonical: 'subscriber', pattern: 'subscriber(?:s|\\s+count)?' },
  { canonical: 'follower', pattern: 'follower(?:s|\\s+count)?' },
  { canonical: 'impression', pattern: 'impressions?' },
  { canonical: 'view', pattern: 'view(?:s|\\s+count)?' },
  { canonical: 'click', pattern: 'clicks?' },
  { canonical: 'signup', pattern: 'sign[-\\s]?ups?' },
  { canonical: 'conversion', pattern: 'conversions?' },
  { canonical: 'visitor', pattern: 'visitors?' },
  { canonical: 'session', pattern: 'sessions?' },
  { canonical: 'user', pattern: 'users?' },
  { canonical: 'sale', pattern: 'sales?' },
  { canonical: 'order', pattern: 'orders?' },
  { canonical: 'page', pattern: 'pages?' },
  { canonical: 'revenue', pattern: 'revenue' },
  { canonical: 'balance', pattern: 'balance' },
  { canonical: 'price', pattern: 'prices?' },
];

const UNIT_ALIASES: Array<{ canonical: string; pattern: string }> = [
  { canonical: 'percent', pattern: 'percent(?:age)?' },
  { canonical: 'hour', pattern: 'hours?|hrs?' },
  { canonical: 'minute', pattern: 'minutes?|mins?' },
  { canonical: 'second', pattern: 'seconds?|secs?' },
  { canonical: 'kilogram', pattern: 'kilograms?|kgs?' },
  { canonical: 'gram', pattern: 'grams?|g' },
  { canonical: 'pound', pattern: 'pounds?|lbs?' },
  { canonical: 'kilometre', pattern: 'kilometers?|kilometres?|kms?' },
  { canonical: 'mile', pattern: 'miles?' },
];

/** Categorical fields commonly present in factual/analytics reports. */
const CATEGORY_FIELD_ALIASES: Array<{ canonical: string; pattern: string }> = [
  { canonical: 'traffic_source', pattern: '(?:top|primary|leading)?[\\s_-]*traffic[\\s_-]+source' },
  { canonical: 'referrer', pattern: '(?:top|primary|leading)?[\\s_-]*referr(?:er|al)' },
  { canonical: 'campaign', pattern: '(?:top|primary|leading)?[\\s_-]*campaign' },
  { canonical: 'content', pattern: '(?:top|best|leading|most[\\s_-]+popular)?[\\s_-]*(?:content|video|post|page)' },
  { canonical: 'device', pattern: '(?:top|primary|leading)?[\\s_-]*(?:device|device[\\s_-]+type)' },
  { canonical: 'platform', pattern: '(?:top|primary|leading)?[\\s_-]*platform' },
  { canonical: 'country', pattern: '(?:top|primary|leading)?[\\s_-]*country' },
  { canonical: 'city', pattern: '(?:top|primary|leading)?[\\s_-]*city' },
  { canonical: 'channel', pattern: '(?:top|primary|leading)?[\\s_-]*channel' },
  { canonical: 'status', pattern: '(?:account|service|release|deployment|flight|order)?[\\s_-]*status' },
  { canonical: 'plan', pattern: '(?:account[\\s_-]+)?(?:plan|tier)' },
  { canonical: 'currency', pattern: '(?:account[\\s_-]+)?currency' },
];

const CATEGORY_VALUE_RE = '[\\p{L}\\p{N}][\\p{L}\\p{N} _&+./-]{0,79}';

function normalizeCategoryValue(value: string): string | null {
  // The permissive value grammar allows dots in domains (for example a
  // referrer host), but must not swallow the next natural-language sentence.
  const sentenceBounded = value.split(
    /\.\s+(?=(?:[A-Z]|top\b|primary\b|leading\b|traffic\b|device\b|platform\b|country\b|city\b|channel\b|status\b|plan\b|currency\b))/u,
    1,
  )[0] ?? value;
  const normalized = sentenceBounded
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^["'`\\s]+|["'`\\s]+$/g, '')
    .replace(/\\s+/g, ' ')
    .replace(/^(?:the|a|an)\\s+/, '')
    .replace(/[.,;:!?]+$/g, '')
    .trim();
  if (!normalized || normalized.length > 80) return null;
  return normalized;
}

function extractCategoricalClaims(text: string): string[] {
  const claims: string[] = [];
  for (const alias of CATEGORY_FIELD_ALIASES) {
    // Handles JSON/key-value and natural language such as
    // `top_traffic_source: YouTube Search` or `Top traffic source is Direct`.
    const fieldFirst = new RegExp(
      `(?:["']?${alias.pattern}["']?)\\s*(?::|=|\\bis\\b|\\bwas\\b|\\bremains?\\b)\\s*["']?(${CATEGORY_VALUE_RE})["']?`,
      'giu',
    );
    for (const match of text.matchAll(fieldFirst)) {
      const value = normalizeCategoryValue(match[1]);
      if (value) claims.push(`category:${alias.canonical}:value:${value}`);
    }

    // Also accept the natural inverse: `YouTube Search was the top traffic source`.
    const valueFirst = new RegExp(
      `(${CATEGORY_VALUE_RE})\\s+(?:is|was|remains?)\\s+(?:the\\s+)?(?:["']?${alias.pattern}["']?)(?=$|[.!,;\\n])`,
      'giu',
    );
    for (const match of text.matchAll(valueFirst)) {
      const value = normalizeCategoryValue(match[1]);
      if (value) claims.push(`category:${alias.canonical}:value:${value}`);
    }
  }

  // Bind direction-only metric claims as well as figures. This prevents an
  // authoritative source saying "subscribers decreased" from grounding an
  // invented claim that they increased merely because neither sentence has a
  // number.
  const trendWords: Array<{ canonical: string; pattern: string }> = [
    { canonical: 'increase', pattern: 'increased?|grew|grown|rose|risen|up' },
    { canonical: 'decrease', pattern: 'decreased?|declined?|fell|fallen|dropped?|down' },
    { canonical: 'stable', pattern: 'stable|flat|unchanged' },
  ];
  for (const metric of METRIC_ALIASES) {
    for (const trend of trendWords) {
      const metricFirst = new RegExp(`\\b(?:${metric.pattern})\\b[^.!?\\n]{0,32}\\b(?:${trend.pattern})\\b`, 'giu');
      const trendFirst = new RegExp(`\\b(?:${trend.pattern})\\b[^.!?\\n]{0,32}\\b(?:${metric.pattern})\\b`, 'giu');
      if (metricFirst.test(text) || trendFirst.test(text)) {
        claims.push(`trend:${metric.canonical}:${trend.canonical}`);
      }
    }
  }
  return claims;
}

function validDate(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function canonicalDate(year: number, month: number, day: number): string | null {
  if (!validDate(year, month, day)) return null;
  return `date:${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeNumber(raw: string): string | null {
  const cleaned = raw.toLowerCase().replace(/[$€£,%\s,]/g, '');
  const suffix = cleaned.match(/[kmb]$/)?.[0];
  const numericText = suffix ? cleaned.slice(0, -1) : cleaned;
  const value = Number(numericText);
  if (!Number.isFinite(value)) return null;
  const multiplier = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : suffix === 'b' ? 1_000_000_000 : 1;
  const normalized = value * multiplier;
  return `number:${Number.isInteger(normalized) ? String(normalized) : normalized.toString()}`;
}

function canonicalNearbyMetric(text: string, start: number, end: number, raw: string): string | null {
  const before = text.slice(Math.max(0, start - 64), start).toLowerCase();
  const after = text.slice(end, Math.min(text.length, end + 64)).toLowerCase();
  const findAlias = (aliases: Array<{ canonical: string; pattern: string }>): string | null => {
    for (const alias of aliases) {
      const beforePattern = new RegExp(
        `(?:${alias.pattern})(?:\\s*["']?\\s*[:=]|\\s+(?:is|was|at|of|total(?:ed)?))?\\s*[$€£]?\\s*$`,
        'i',
      );
      const afterPattern = new RegExp(`^\\s*["']?\\s*(?:total\\s+)?(?:${alias.pattern})\\b`, 'i');
      if (beforePattern.test(before) || afterPattern.test(after)) return alias.canonical;
    }
    return null;
  };
  const namedMetric = findAlias(METRIC_ALIASES);
  if (namedMetric) return namedMetric;
  const unit = findAlias(UNIT_ALIASES);
  if (unit) return unit;
  if (raw.includes('%')) return 'percent';
  if (raw.includes('$')) return 'usd';
  if (raw.includes('€')) return 'eur';
  if (raw.includes('£')) return 'gbp';
  return null;
}

/**
 * Extract externally checkable numeric, date, and categorical claims. Text
 * itself is never retained in a receipt. Markdown list ordinals are removed
 * before scanning so presentation numbering does not become a false claim.
 */
export function extractNormalizedEvidenceClaims(input: string): string[] {
  let text = input.replace(/^\s*\d+[.)]\s+/gm, '');
  const claims: string[] = extractCategoricalClaims(text);

  const datePatterns: Array<{
    regex: RegExp;
    toClaim: (match: RegExpExecArray) => string | null;
  }> = [
    {
      regex: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g,
      toClaim: match => canonicalDate(Number(match[1]), Number(match[2]), Number(match[3])),
    },
    {
      regex: new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(\\d{4})\\b`, 'gi'),
      toClaim: match => canonicalDate(Number(match[3]), MONTHS[match[1].toLowerCase()], Number(match[2])),
    },
    {
      regex: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})[,]?\\s+(\\d{4})\\b`, 'gi'),
      toClaim: match => canonicalDate(Number(match[3]), MONTHS[match[2].toLowerCase()], Number(match[1])),
    },
  ];

  for (const { regex, toClaim } of datePatterns) {
    text = text.replace(regex, (...args: unknown[]) => {
      const match = args.slice(0, -2) as unknown as RegExpExecArray;
      const claim = toClaim(match);
      if (claim) claims.push(claim);
      return ' ';
    });
  }

  const numberPattern = /(?:[$€£]\s*)?[-+]?\d[\d,]*(?:\.\d+)?(?:\s*[kmb](?![a-z]))?%?/gi;
  for (const match of text.matchAll(numberPattern)) {
    // Skip digits embedded in identifiers/URLs such as EK204 or v1beta.
    const start = match.index ?? 0;
    const before = text[start - 1] ?? '';
    const after = text[start + match[0].length] ?? '';
    if (/[a-z_]/i.test(before) || /[a-z_]/i.test(after)) continue;
    const normalized = normalizeNumber(match[0]);
    if (normalized) {
      const metric = canonicalNearbyMetric(text, start, start + match[0].length, match[0]);
      claims.push(metric ? `${normalized}|metric:${metric}` : normalized);
    }
  }
  return [...new Set(claims)];
}

export function digestEvidenceClaim(claim: string): string {
  return createHash('sha256').update(`${CLAIM_DOMAIN}${claim}`).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/** Domain-separated privacy-safe digest for source/request/account binding. */
export function digestEvidenceProvenance(kind: string, value: unknown): string {
  return createHash('sha256')
    .update(`${PROVENANCE_DOMAIN}${kind}:${stableStringify(value)}`)
    .digest('hex');
}

export function buildEvidenceExecutionContext(
  taskRequest: string,
  accountScope: string,
): EvidenceExecutionContext {
  return {
    taskRequestDigest: digestEvidenceProvenance('task-request', taskRequest),
    accountScopeDigest: digestEvidenceProvenance('account-scope', accountScope),
  };
}

/**
 * Mint provenance at the runtime tool boundary. Authority is fail-closed: an
 * installed skill needs an explicit source declaration, while generic code,
 * shell, memory and workflow tools can never self-promote to evidence sources.
 */
export function buildRuntimeEvidenceProvenance(input: {
  toolName: string;
  toolInput: unknown;
  skillSource?: string;
  skillPath?: string;
  declaration?: EvidenceSourceDeclaration;
  executionContext?: Partial<EvidenceExecutionContext>;
  accountScope?: string;
}): Required<Pick<EvidenceProvenanceReceipt,
  'authority' | 'sourceDigest' | 'toolRequestDigest' | 'accountScopeDigest'>>
  & Pick<EvidenceProvenanceReceipt, 'taskRequestDigest'> {
  const normalizedTool = input.toolName.trim().toLowerCase();
  const declaredSource = input.declaration?.source?.trim();
  const authoritative = input.declaration?.authoritative === true
    && Boolean(declaredSource)
    && !NEVER_AUTHORITATIVE_EVIDENCE_TOOLS.has(normalizedTool);
  return {
    authority: authoritative ? 'authoritative' : 'untrusted',
    sourceDigest: digestEvidenceProvenance('source', {
      toolName: normalizedTool,
      source: declaredSource ?? 'undeclared',
      skillSource: input.skillSource ?? 'unknown',
      skillPath: input.skillPath ?? 'unknown',
    }),
    toolRequestDigest: digestEvidenceProvenance('tool-request', input.toolInput),
    taskRequestDigest: input.executionContext?.taskRequestDigest,
    accountScopeDigest: input.executionContext?.accountScopeDigest
      ?? digestEvidenceProvenance('account-scope', input.accountScope ?? 'default'),
  };
}

export function isAuthoritativeEvidenceReceipt(
  receipt: AuthoritativeEvidenceReceipt,
  expectedContext?: Partial<EvidenceExecutionContext>,
): boolean {
  if (receipt.authority !== 'authoritative') return false;
  if (NEVER_AUTHORITATIVE_EVIDENCE_TOOLS.has(receipt.toolName.trim().toLowerCase())) return false;
  if (![receipt.sourceDigest, receipt.toolRequestDigest, receipt.taskRequestDigest, receipt.accountScopeDigest]
    .every(value => typeof value === 'string' && SHA256_RE.test(value))) return false;
  if (expectedContext?.taskRequestDigest
    && receipt.taskRequestDigest !== expectedContext.taskRequestDigest) return false;
  if (expectedContext?.accountScopeDigest
    && receipt.accountScopeDigest !== expectedContext.accountScopeDigest) return false;
  return true;
}

/** Build a bounded, content-redacted ledger while raw tool output is in memory. */
export function buildEvidenceClaimLedger(output: string): EvidenceClaimLedger {
  const sourceWasTruncated = output.length > MAX_EVIDENCE_SCAN_CHARS;
  const claims = extractNormalizedEvidenceClaims(output.slice(0, MAX_EVIDENCE_SCAN_CHARS));
  const bounded = claims.slice(0, MAX_EVIDENCE_CLAIM_DIGESTS);
  return {
    claimDigests: bounded.map(digestEvidenceClaim),
    claimLedgerTruncated: sourceWasTruncated || claims.length > bounded.length,
  };
}

/**
 * Verify every extracted factual claim in the public response was present in
 * at least one verified source receipt. Reasons expose counts, never values.
 */
export function verifyResponseEvidenceClaims(
  response: string,
  receipts: readonly EvidenceClaimReceipt[],
): { passed: boolean; claimCount: number; missingCount: number; reason?: string } {
  const claims = extractNormalizedEvidenceClaims(response);
  if (claims.length === 0) return { passed: true, claimCount: 0, missingCount: 0 };
  const available = new Set(receipts.flatMap(receipt => receipt.claimDigests ?? []));
  const missingCount = claims
    .map(digestEvidenceClaim)
    .filter(digest => !available.has(digest)).length;
  return missingCount === 0
    ? { passed: true, claimCount: claims.length, missingCount: 0 }
    : {
        passed: false,
        claimCount: claims.length,
        missingCount,
        reason: `${missingCount} of ${claims.length} factual claim(s) were not grounded in verified tool output`,
      };
}

/**
 * Remove public lines containing factual claims absent from verified receipts.
 * This is a last-mile quarantine for foreground research/reporting: useful
 * sourced prose survives, while invented figures never become fluent output.
 */
export function quarantineUngroundedResponseClaims(
  response: string,
  receipts: readonly EvidenceClaimReceipt[],
): { response: string; removedLines: number; claimCount: number; missingCount: number } {
  const available = new Set(receipts.flatMap(receipt => receipt.claimDigests ?? []));
  let removedLines = 0;
  let claimCount = 0;
  let missingCount = 0;
  const kept = response.split('\n').filter(line => {
    const claims = extractNormalizedEvidenceClaims(line);
    if (claims.length === 0) return true;
    claimCount += claims.length;
    const missing = claims.map(digestEvidenceClaim).filter(digest => !available.has(digest));
    missingCount += missing.length;
    if (missing.length === 0) return true;
    removedLines++;
    return false;
  });
  let sanitized = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (removedLines > 0) {
    const note = 'I omitted factual figures that were not supported by the retrieved sources.';
    sanitized = sanitized ? `${sanitized}\n\n${note}` : note;
  }
  return { response: sanitized, removedLines, claimCount, missingCount };
}
