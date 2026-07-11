const SOFT_FAILURES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b404\s+(?:not found|page not found)\b/i, reason: 'soft 404 page' },
  { pattern: /\bNoSuchBucket\b/i, reason: 'missing storage bucket' },
  { pattern: /\bplease solve the challenge\b/i, reason: 'bot challenge page' },
  { pattern: /\baccess denied\b[\s\S]{0,120}\b(?:captcha|automated|bot)\b/i, reason: 'access challenge page' },
  { pattern: /\bthe document has moved\b[\s\S]{0,200}\bconsent\./i, reason: 'consent redirect page' },
];

export function unusableWebContentReason(text: string): string | null {
  const sample = text.slice(0, 8_000);
  return SOFT_FAILURES.find(candidate => candidate.pattern.test(sample))?.reason ?? null;
}
