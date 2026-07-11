import { describe, expect, it } from 'vitest';
import {
  buildEvidenceClaimLedger,
  buildEvidenceExecutionContext,
  buildRuntimeEvidenceProvenance,
  extractNormalizedEvidenceClaims,
  isAuthoritativeEvidenceReceipt,
  verifyResponseEvidenceClaims,
} from './evidence-grounding.js';

describe('privacy-safe factual claim grounding', () => {
  it('normalizes numbers and equivalent calendar date formats', () => {
    expect(extractNormalizedEvidenceClaims('2,350 views on July 11, 2026')).toEqual([
      'date:2026-07-11',
      'number:2350|metric:view',
    ]);
    const ledger = buildEvidenceClaimLedger('455 subscribers; measured July 11, 2026');
    expect(verifyResponseEvidenceClaims('455 subscribers on 2026-07-11', [ledger])).toMatchObject({
      passed: true,
      claimCount: 2,
    });
  });

  it('rejects a fabricated number absent from tool output', () => {
    const ledger = buildEvidenceClaimLedger('The API returned 455 subscribers.');
    expect(verifyResponseEvidenceClaims('The channel has 999 subscribers.', [ledger])).toMatchObject({
      passed: false,
      missingCount: 1,
    });
  });

  it('binds equal numbers to their nearby canonical metric', () => {
    const ledger = buildEvidenceClaimLedger('The API returned 455 views.');
    expect(verifyResponseEvidenceClaims('The channel has 455 subscribers.', [ledger]))
      .toMatchObject({ passed: false, missingCount: 1 });
    expect(verifyResponseEvidenceClaims('The channel has 455 view.', [ledger]))
      .toMatchObject({ passed: true, missingCount: 0 });
    expect(extractNormalizedEvidenceClaims('{"subscribers":455}'))
      .toEqual(['number:455|metric:subscriber']);
    const ctrLedger = buildEvidenceClaimLedger('{"ctr":12}');
    expect(verifyResponseEvidenceClaims('CTR was 12%.', [ctrLedger]))
      .toMatchObject({ passed: true });
  });

  it('does not mistake markdown list ordinals for factual claims', () => {
    expect(extractNormalizedEvidenceClaims('1. First point\n2) Second point')).toEqual([]);
  });

  it('stores only bounded hashes, never raw claim values', () => {
    const ledger = buildEvidenceClaimLedger('455 subscribers');
    expect(ledger.claimDigests).toHaveLength(1);
    expect(ledger.claimDigests[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(ledger)).not.toContain('455');
  });

  it('binds categorical analytics claims instead of accepting unsupported prose', () => {
    const ledger = buildEvidenceClaimLedger('{"top_traffic_source":"Direct","device":"Mobile"}');
    expect(extractNormalizedEvidenceClaims('Top traffic source is Direct. Device: Mobile.'))
      .toEqual(expect.arrayContaining([
        'category:traffic_source:value:direct',
        'category:device:value:mobile',
      ]));
    expect(verifyResponseEvidenceClaims('The top traffic source is Direct.', [ledger]))
      .toMatchObject({ passed: true });
    expect(verifyResponseEvidenceClaims('The top traffic source is YouTube Search.', [ledger]))
      .toMatchObject({ passed: false, missingCount: 1 });
  });

  it('mints authoritative provenance only for explicitly declared source skills', () => {
    const executionContext = buildEvidenceExecutionContext('Daily channel report', 'account-123');
    const authoritative = buildRuntimeEvidenceProvenance({
      toolName: 'youtube_analytics',
      toolInput: { channel: 'mine', fields: ['subscribers'] },
      skillSource: 'workspace',
      skillPath: '/skills/youtube/SKILL.md',
      declaration: { authoritative: true, source: 'youtube-analytics-api:v2' },
      executionContext,
    });
    expect(isAuthoritativeEvidenceReceipt({
      toolName: 'youtube_analytics', success: true, completedAt: 1,
      outputDigest: 'a'.repeat(64), outputBytes: 10,
      ...authoritative,
    }, executionContext)).toBe(true);
    expect(JSON.stringify(authoritative)).not.toContain('account-123');

    const undeclared = buildRuntimeEvidenceProvenance({
      toolName: 'custom_report', toolInput: {}, accountScope: 'account-123',
    });
    const disguisedShell = buildRuntimeEvidenceProvenance({
      toolName: 'bash', toolInput: { command: 'echo 76000 subscribers' },
      declaration: { authoritative: true, source: 'invented-output' },
      executionContext,
    });
    expect(undeclared.authority).toBe('untrusted');
    expect(disguisedShell.authority).toBe('untrusted');
  });
});
