import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export interface ArtifactInspection {
  absolutePath: string;
  relativePath: string;
  fileName: string;
  sizeBytes: number;
  modifiedAt: number;
  extension: string;
  sha256: string;
  pdfPageCount?: number;
  pdfProducer?: string;
}

export interface ArtifactValidationResult {
  passed: boolean;
  inspection?: ArtifactInspection;
  code?: 'ARTIFACT_NOT_FOUND' | 'ARTIFACT_STALE_TARGET' | 'ARTIFACT_QUALITY_FAILED' | 'ARTIFACT_CLAIM_MISMATCH';
  reason?: string;
  suggestedPath?: string;
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'));
}

function pdfPageCount(bytes: Buffer): number {
  const latin = bytes.toString('latin1');
  return [...latin.matchAll(/\/Type\s*\/Page(?!s)\b/g)].length;
}

export async function inspectArtifact(outputRoot: string, requestedPath: string): Promise<ArtifactInspection> {
  const root = resolve(outputRoot);
  const absolutePath = resolve(root, requestedPath.replace(/^output[\\/]/, ''));
  if (!within(root, absolutePath)) throw new Error('Artifact path escapes output directory');
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error('Artifact path is not a file');
  const extension = extname(absolutePath).toLowerCase();
  const inspection: ArtifactInspection = {
    absolutePath,
    relativePath: `output/${relative(root, absolutePath).replaceAll('\\', '/')}`,
    fileName: basename(absolutePath),
    sizeBytes: info.size,
    modifiedAt: info.mtimeMs,
    extension,
    sha256: '',
  };
  const bytes = await readFile(absolutePath);
  inspection.sha256 = createHash('sha256').update(bytes).digest('hex');
  if (extension === '.pdf') {
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('File extension is PDF but content is not a PDF');
    inspection.pdfPageCount = pdfPageCount(bytes);
    inspection.pdfProducer = bytes.toString('latin1').match(/\/Producer\s*\(([^)]{1,160})\)/)?.[1];
  }
  return inspection;
}

export async function validateArtifactForDelivery(input: {
  outputRoot: string;
  requestedPath: string;
  userMessage?: string;
  previousAssistantMessage?: string;
  caption?: string;
  turnStartedAt?: number;
}): Promise<ArtifactValidationResult> {
  let inspection: ArtifactInspection;
  try {
    inspection = await inspectArtifact(input.outputRoot, input.requestedPath);
  } catch (error) {
    return { passed: false, code: 'ARTIFACT_NOT_FOUND', reason: (error as Error).message };
  }

  const currentInstruction = (() => {
    const raw = input.userMessage?.trim() ?? '';
    if (!raw.startsWith('[Replying to ')) return raw;
    const end = raw.lastIndexOf('"]');
    return end >= 0 ? raw.slice(end + 2).trim() : raw;
  })();
  const currentNamesExactFile = currentInstruction.toLowerCase().includes(inspection.fileName.toLowerCase());
  const entries = await readdir(resolve(input.outputRoot), { withFileTypes: true });
  const siblings = (await Promise.all(entries
    .filter(entry => entry.isFile() && extname(entry.name).toLowerCase() === inspection.extension)
    .map(async entry => inspectArtifact(input.outputRoot, entry.name).catch(() => null))))
    .filter((entry): entry is ArtifactInspection => entry !== null)
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
  const newer = siblings.find(candidate => candidate.modifiedAt > inspection.modifiedAt + 1_000);
  const vagueDelivery = /\b(?:send|share|attach|upload)\s+(?:it|that|this|the\s+(?:file|pdf|report|document))\b/i.test(currentInstruction)
    && !currentNamesExactFile;
  const olderThanThirtyMinutes = input.turnStartedAt !== undefined
    && inspection.modifiedAt < input.turnStartedAt - 30 * 60_000;
  if (!currentNamesExactFile && (newer || (vagueDelivery && olderThanThirtyMinutes))) {
    return {
      passed: false,
      inspection,
      code: 'ARTIFACT_STALE_TARGET',
      reason: newer
        ? `A newer ${inspection.extension || 'artifact'} exists; refusing to substitute the older file without an exact filename.`
        : 'The request refers vaguely to a file, but the selected artifact predates the current work by more than 30 minutes.',
      suggestedPath: newer?.relativePath,
    };
  }

  if (inspection.extension === '.pdf') {
    const context = `${input.userMessage ?? ''}\n${input.previousAssistantMessage ?? ''}\n${input.caption ?? ''}`;
    const typstRequired = /\btypst|typist\b/i.test(context) || /typst|typist/i.test(inspection.fileName);
    if (typstRequired && !/typst/i.test(inspection.pdfProducer ?? '')) {
      return {
        passed: false,
        inspection,
        code: 'ARTIFACT_QUALITY_FAILED',
        reason: 'The requested Typst/“typist” artifact was not produced by Typst. Clarify the renderer if needed, then rebuild with Typst.',
      };
    }
    const substantialReport = /\b(?:analysis|deep research|detailed|comprehensive|report|swot|matrix|forecast)\b/i.test(context);
    if (substantialReport && (inspection.sizeBytes < 4_096 || (inspection.pdfPageCount ?? 0) < 2)) {
      return {
        passed: false,
        inspection,
        code: 'ARTIFACT_QUALITY_FAILED',
        reason: `The PDF is only ${inspection.sizeBytes} bytes and ${inspection.pdfPageCount ?? 0} page(s), which does not support the requested substantial report.`,
      };
    }
    const claimedPages = input.caption?.match(/\b(\d{1,3})\s+pages?\b/i)?.[1];
    if (claimedPages && Number(claimedPages) !== inspection.pdfPageCount) {
      return {
        passed: false,
        inspection,
        code: 'ARTIFACT_CLAIM_MISMATCH',
        reason: `Caption claims ${claimedPages} pages, but the PDF contains ${inspection.pdfPageCount ?? 0}.`,
      };
    }
  }

  return { passed: true, inspection };
}
