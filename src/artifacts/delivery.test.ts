import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectArtifact, validateArtifactForDelivery } from './delivery.js';

function fakePdf(pages: number, padding = 0): Buffer {
  return Buffer.from(`%PDF-1.4\n${Array.from({ length: pages }, (_, i) => `${i + 1} 0 obj << /Type /Page >> endobj`).join('\n')}\n${'x'.repeat(padding)}\n%%EOF`);
}

describe('artifact delivery validation', () => {
  let output: string;
  beforeEach(async () => {
    output = await mkdtemp(join(tmpdir(), 'artifact-delivery-'));
  });
  afterEach(async () => {
    await rm(output, { recursive: true, force: true });
  });

  it('reports verifiable PDF metadata', async () => {
    await writeFile(join(output, 'report.pdf'), fakePdf(3, 5_000));
    await expect(inspectArtifact(output, 'output/report.pdf')).resolves.toMatchObject({
      relativePath: 'output/report.pdf', pdfPageCount: 3,
    });
  });

  it('refuses an older sibling for a vague send request and suggests the newest artifact', async () => {
    const oldPath = join(output, 'analysis.pdf');
    const newPath = join(output, 'analysis_typst.pdf');
    await writeFile(oldPath, fakePdf(5, 5_000));
    await writeFile(newPath, fakePdf(5, 5_000));
    const now = new Date();
    await utimes(oldPath, new Date(now.getTime() - 60_000), new Date(now.getTime() - 60_000));
    await utimes(newPath, now, now);

    await expect(validateArtifactForDelivery({
      outputRoot: output,
      requestedPath: 'output/analysis.pdf',
      userMessage: 'Send the competitor analysis PDF file to me now',
      turnStartedAt: now.getTime(),
    })).resolves.toMatchObject({
      passed: false,
      code: 'ARTIFACT_STALE_TARGET',
      suggestedPath: 'output/analysis_typst.pdf',
    });
  });

  it('rejects a tiny one-page placeholder presented as deep research', async () => {
    await writeFile(join(output, 'analysis_typst.pdf'), fakePdf(1, 100));
    await expect(validateArtifactForDelivery({
      outputRoot: output,
      requestedPath: 'output/analysis_typst.pdf',
      userMessage: 'Send the deep research competitor analysis PDF',
    })).resolves.toMatchObject({ passed: false, code: 'ARTIFACT_QUALITY_FAILED' });
  });

  it('rejects a caption whose page count disagrees with the file', async () => {
    await writeFile(join(output, 'report.pdf'), fakePdf(2, 5_000));
    await expect(validateArtifactForDelivery({
      outputRoot: output,
      requestedPath: 'output/report.pdf',
      userMessage: 'Send report.pdf',
      caption: 'Your complete 8 page report',
    })).resolves.toMatchObject({ passed: false, code: 'ARTIFACT_CLAIM_MISMATCH' });
  });
});
