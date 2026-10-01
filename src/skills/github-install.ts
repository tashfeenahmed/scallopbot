/**
 * Install a skill folder straight from GitHub, e.g.
 *   https://github.com/anthropics/skills/tree/main/skills/pdf
 *   https://github.com/owner/repo                 (SKILL.md at the repo root)
 *   https://github.com/owner/repo/blob/main/x/SKILL.md
 *
 * Downloads the repository zip once (bounded size), extracts only the chosen
 * folder into ~/.scallopbot/skills/<name>, and refuses path traversal,
 * symlink-like entries, hidden files, and oversized folders. The folder must
 * contain a SKILL.md (OpenClaw or plain agentskills.io format).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { unzipSync } from 'fflate';
import { parseFrontmatter } from './parser.js';
import { checkGates, hasExecutableEntrypoint } from './loader.js';
import type { Skill } from './types.js';
import type { InstallResult } from './clawhub.js';

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_SKILL_BYTES = 20 * 1024 * 1024;
const MAX_SKILL_FILES = 500;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export interface GitHubSkillRef {
  owner: string;
  repo: string;
  /** Branch, tag, or commit; undefined = repository default branch. */
  ref?: string;
  /** Folder inside the repo ('' = root). */
  dir: string;
}

export function parseGitHubSkillUrl(url: string): GitHubSkillRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2) return null;
  const [owner, rawRepo, kind, ref, ...rest] = parts;
  const repo = rawRepo.replace(/\.git$/, '');
  if (![owner, repo].every(part => SEGMENT_RE.test(part))) return null;
  if (kind === undefined) return { owner, repo, dir: '' };
  if ((kind !== 'tree' && kind !== 'blob') || !ref || !SEGMENT_RE.test(ref)) return null;
  const segments = kind === 'blob' && rest.at(-1) === 'SKILL.md' ? rest.slice(0, -1) : rest;
  if (segments.some(segment => !SEGMENT_RE.test(segment) || segment === '..' || segment === '.')) return null;
  return { owner, repo, ref, dir: segments.join('/') };
}

export interface GitHubInstallOptions {
  skillsDir?: string;
  fetchImpl?: typeof fetch;
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > limit) throw new Error(`archive exceeds ${limit} bytes`);
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`archive exceeds ${limit} bytes`);
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

export async function installSkillFromGitHub(
  url: string,
  options: GitHubInstallOptions = {},
): Promise<InstallResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const skillsDir = options.skillsDir ?? path.join(homedir(), '.scallopbot', 'skills');
  const target = parseGitHubSkillUrl(url);
  if (!target) {
    return { success: false, error: `Not a supported GitHub skill URL: ${url}` };
  }

  let staging: string | undefined;
  try {
    const ref = target.ref ?? 'HEAD';
    // github.com/.../archive/<ref>.zip redirects to codeload and accepts HEAD.
    const archiveUrl = `https://github.com/${target.owner}/${target.repo}/archive/${ref}.zip`;
    const response = await doFetch(archiveUrl, { headers: { 'User-Agent': 'scallopbot-skill-installer' } });
    if (!response.ok) {
      return { success: false, error: `Failed to download ${target.owner}/${target.repo}@${ref}: HTTP ${response.status}` };
    }
    const archive = await readBounded(response, MAX_ARCHIVE_BYTES);

    // Every entry sits under one top-level folder (repo-ref/); only decompress
    // entries under <top>/<dir>/.
    let prefix: string | undefined;
    const wanted = (name: string): boolean => {
      const top = name.split('/')[0];
      prefix ??= `${top}/${target.dir ? `${target.dir}/` : ''}`;
      return name.startsWith(prefix) && !name.endsWith('/');
    };
    const files = unzipSync(archive, { filter: file => wanted(file.name) });

    const entries = Object.entries(files)
      .map(([name, content]) => [name.slice(prefix!.length), content] as const)
      .filter(([rel]) => rel.length > 0);
    if (!entries.some(([rel]) => rel === 'SKILL.md')) {
      return { success: false, error: `No SKILL.md found at ${target.dir || 'the repository root'}` };
    }
    if (entries.length > MAX_SKILL_FILES) {
      return { success: false, error: `Skill folder has more than ${MAX_SKILL_FILES} files` };
    }
    const totalBytes = entries.reduce((sum, [, content]) => sum + content.byteLength, 0);
    if (totalBytes > MAX_SKILL_BYTES) {
      return { success: false, error: `Skill folder exceeds ${MAX_SKILL_BYTES} bytes` };
    }

    const skillMd = Buffer.from(entries.find(([rel]) => rel === 'SKILL.md')![1]).toString('utf8');
    const parsed = parseFrontmatter(skillMd, url);
    const name = parsed.frontmatter.name;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) {
      return { success: false, error: `Invalid skill name "${name}"` };
    }

    await fs.mkdir(skillsDir, { recursive: true });
    staging = await fs.mkdtemp(path.join(skillsDir, `.install-${name}-`));
    for (const [rel, content] of entries) {
      const segments = rel.split('/');
      // Hidden files/dirs and traversal never leave the archive.
      if (segments.some(segment => !segment || segment === '..' || segment.startsWith('.'))) continue;
      const destination = path.join(staging, ...segments);
      if (!destination.startsWith(staging + path.sep)) continue;
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content, { mode: 0o644 });
    }
    const checksum = createHash('sha256').update(archive).digest('hex');
    await fs.writeFile(path.join(staging, '.version.json'), JSON.stringify({
      version: target.ref ?? 'HEAD',
      installedAt: new Date().toISOString(),
      checksum,
      sourceUrl: url,
    }, null, 2));

    const skillDir = path.join(skillsDir, name);
    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.rename(staging, skillDir);
    staging = undefined;

    const skillPath = path.join(skillDir, 'SKILL.md');
    const scriptsDir = path.join(skillDir, 'scripts');
    const hasScripts = await fs.stat(scriptsDir).then(s => s.isDirectory(), () => false) &&
      await hasExecutableEntrypoint(skillDir, parsed.frontmatter);
    const gate = checkGates(parsed.frontmatter.metadata);
    const skill: Skill = {
      name,
      description: parsed.frontmatter.description,
      path: skillPath,
      source: 'local',
      frontmatter: parsed.frontmatter,
      content: parsed.content,
      available: gate.available,
      unavailableReason: gate.reason,
      hasScripts,
      scriptsDir: hasScripts ? scriptsDir : undefined,
    };
    return { success: true, skill, path: skillPath, checksum };
  } catch (error) {
    return { success: false, error: `GitHub install failed: ${(error as Error).message}` };
  } finally {
    if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
