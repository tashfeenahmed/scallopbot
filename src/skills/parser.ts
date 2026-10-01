/**
 * Skill Parser
 *
 * Parses SKILL.md files with YAML frontmatter following the OpenClaw format.
 *
 * Format:
 * ```markdown
 * ---
 * name: skill-name
 * description: What the skill does
 * metadata:
 *   openclaw:
 *     requires:
 *       bins: [required-binary]
 * ---
 *
 * # Instructions for the agent
 * ...markdown content...
 * ```
 *
 * Plain Anthropic / agentskills.io skills are accepted as-is: only `name` and
 * `description` are required; `license`, `compatibility`, `allowed-tools` and
 * free-form `metadata` are optional. Such skills are instruction-only unless
 * they also opt into ScallopBot's executable-script conventions.
 */

import yaml from 'js-yaml';
import type { SkillFrontmatter, SkillMetadata } from './types.js';

/**
 * Result of parsing a skill file
 */
export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  content: string;
}

/**
 * Parse error with context
 */
export class SkillParseError extends Error {
  constructor(
    message: string,
    public readonly path?: string,
    public readonly cause?: unknown
  ) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'SkillParseError';
  }
}

/**
 * Frontmatter delimiter regex
 */
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse YAML frontmatter from skill file content
 */
export function parseFrontmatter(content: string, path?: string): ParsedSkill {
  const match = content.match(FRONTMATTER_REGEX);

  if (!match) {
    throw new SkillParseError(
      'Invalid skill file format: missing YAML frontmatter (---)',
      path
    );
  }

  const [, yamlContent, markdownContent] = match;

  try {
    const parsed = yaml.load(yamlContent) as Record<string, unknown>;

    if (!parsed || typeof parsed !== 'object') {
      throw new SkillParseError('Frontmatter must be a YAML object', path);
    }

    // Validate required fields
    if (!parsed.name || typeof parsed.name !== 'string') {
      throw new SkillParseError('Skill frontmatter must include a "name" field', path);
    }

    if (!parsed.description || typeof parsed.description !== 'string') {
      throw new SkillParseError(
        'Skill frontmatter must include a "description" field',
        path
      );
    }

    // Build frontmatter object
    const frontmatter: SkillFrontmatter = {
      name: parsed.name,
      description: parsed.description,
    };

    // Optional fields
    if (parsed.homepage && typeof parsed.homepage === 'string') {
      frontmatter.homepage = parsed.homepage;
    }

    if (typeof parsed['user-invocable'] === 'boolean') {
      frontmatter['user-invocable'] = parsed['user-invocable'];
    }

    if (typeof parsed['disable-model-invocation'] === 'boolean') {
      frontmatter['disable-model-invocation'] = parsed['disable-model-invocation'];
    }

    if (parsed['command-dispatch'] === 'tool') {
      frontmatter['command-dispatch'] = 'tool';
    }

    if (parsed['command-tool'] && typeof parsed['command-tool'] === 'string') {
      frontmatter['command-tool'] = parsed['command-tool'];
    }

    if (parsed['command-arg-mode'] === 'raw') {
      frontmatter['command-arg-mode'] = 'raw';
    }

    // agentskills.io optional fields
    if (typeof parsed.license === 'string' && parsed.license.trim()) {
      frontmatter.license = parsed.license.trim();
    }
    if (typeof parsed.compatibility === 'string' && parsed.compatibility.trim()) {
      frontmatter.compatibility = parsed.compatibility.trim();
    }
    const allowedTools = parseAllowedTools(parsed['allowed-tools']);
    if (allowedTools) {
      frontmatter['allowed-tools'] = allowedTools;
    }

    // Parse metadata
    if (parsed.metadata && typeof parsed.metadata === 'object') {
      frontmatter.metadata = parseMetadata(parsed.metadata as Record<string, unknown>);
    }

    // Parse triggers array
    if (Array.isArray(parsed.triggers)) {
      frontmatter.triggers = parsed.triggers.filter((x) => typeof x === 'string');
    }

    // Parse scripts map
    if (parsed.scripts && typeof parsed.scripts === 'object') {
      frontmatter.scripts = {};
      for (const [key, value] of Object.entries(parsed.scripts as Record<string, unknown>)) {
        if (typeof value === 'string') {
          frontmatter.scripts[key] = value;
        }
      }
    }

    // Parse inputSchema
    if (parsed.inputSchema && typeof parsed.inputSchema === 'object') {
      const schema = parsed.inputSchema as Record<string, unknown>;
      if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
        frontmatter.inputSchema = {
          type: 'object',
          properties: schema.properties as Record<string, { type: string; description?: string }>,
        };
        if (Array.isArray(schema.required)) {
          frontmatter.inputSchema.required = schema.required.filter((x) => typeof x === 'string');
        }
      }
    }

    return {
      frontmatter,
      content: markdownContent.trim(),
    };
  } catch (error) {
    if (error instanceof SkillParseError) {
      throw error;
    }
    throw new SkillParseError(
      `Failed to parse YAML frontmatter: ${(error as Error).message}`,
      path,
      error
    );
  }
}

/** `allowed-tools` is a space-delimited string in the spec; also accept a YAML list. */
function parseAllowedTools(value: unknown): string[] | undefined {
  const items = typeof value === 'string'
    ? value.split(/\s+/)
    : Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
  const tools = items.map(item => item.trim()).filter(Boolean).slice(0, 64);
  return tools.length > 0 ? tools : undefined;
}

/**
 * Parse metadata object
 */
function parseMetadata(raw: Record<string, unknown>): SkillMetadata {
  const metadata: SkillMetadata = {};

  // agentskills.io metadata is a flat string map; keep scalar entries.
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'openclaw') continue;
    if (['string', 'number', 'boolean'].includes(typeof value)) metadata[key] = value;
  }

  if (raw.openclaw && typeof raw.openclaw === 'object') {
    const oc = raw.openclaw as Record<string, unknown>;
    metadata.openclaw = {};

    if (typeof oc.always === 'boolean') {
      metadata.openclaw.always = oc.always;
    }

    if (typeof oc.emoji === 'string') {
      metadata.openclaw.emoji = oc.emoji;
    }

    if (oc.os) {
      if (typeof oc.os === 'string') {
        metadata.openclaw.os = oc.os;
      } else if (Array.isArray(oc.os)) {
        metadata.openclaw.os = oc.os.filter((x) => typeof x === 'string');
      }
    }

    if (typeof oc.primaryEnv === 'string') {
      metadata.openclaw.primaryEnv = oc.primaryEnv;
    }

    if (Array.isArray(oc.optionalEnv)) {
      metadata.openclaw.optionalEnv = oc.optionalEnv.filter((x): x is string => typeof x === 'string');
    }

    // Parse requires
    if (oc.requires && typeof oc.requires === 'object') {
      const req = oc.requires as Record<string, unknown>;
      metadata.openclaw.requires = {};

      if (Array.isArray(req.bins)) {
        metadata.openclaw.requires.bins = req.bins.filter((x) => typeof x === 'string');
      }

      if (Array.isArray(req.anyBins)) {
        metadata.openclaw.requires.anyBins = req.anyBins.filter(
          (x) => typeof x === 'string'
        );
      }

      if (Array.isArray(req.env)) {
        metadata.openclaw.requires.env = req.env.filter((x) => typeof x === 'string');
      }

      if (Array.isArray(req.anyEnv)) {
        metadata.openclaw.requires.anyEnv = req.anyEnv.filter((x): x is string => typeof x === 'string');
      }

      if (Array.isArray(req.config)) {
        metadata.openclaw.requires.config = req.config.filter(
          (x) => typeof x === 'string'
        );
      }
    }

    // Parse typed execution-safety declarations. Leaving these fields behind
    // in raw YAML would make external-write policy appear configured while the
    // runtime silently treated the skill as undeclared.
    if (oc.safety && typeof oc.safety === 'object') {
      const rawSafety = oc.safety as Record<string, unknown>;
      const safety: NonNullable<NonNullable<SkillMetadata['openclaw']>['safety']> = {};
      for (const key of ['readOnly', 'externalWrite', 'localWrite', 'sensitive', 'requiresConfirmation', 'publicCommunication'] as const) {
        if (typeof rawSafety[key] === 'boolean') safety[key] = rawSafety[key];
      }
      if (Array.isArray(rawSafety.confirmActions)) {
        safety.confirmActions = rawSafety.confirmActions
          .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
          .map((x) => x.trim().toLowerCase());
      }
      if (typeof rawSafety.confirmBypassEnv === 'string' && rawSafety.confirmBypassEnv.trim()) {
        safety.confirmBypassEnv = rawSafety.confirmBypassEnv.trim();
      }
      metadata.openclaw.safety = safety;
    }

    if (oc.evidence && typeof oc.evidence === 'object') {
      const rawEvidence = oc.evidence as Record<string, unknown>;
      const evidence: NonNullable<NonNullable<SkillMetadata['openclaw']>['evidence']> = {};
      if (typeof rawEvidence.authoritative === 'boolean') {
        evidence.authoritative = rawEvidence.authoritative;
      }
      if (typeof rawEvidence.source === 'string' && rawEvidence.source.trim()) {
        evidence.source = rawEvidence.source.trim();
      }
      metadata.openclaw.evidence = evidence;
    }

    // Parse install instructions
    if (Array.isArray(oc.install)) {
      metadata.openclaw.install = oc.install
        .filter((i) => i && typeof i === 'object')
        .map((i) => {
          const installer = i as Record<string, unknown>;
          return {
            id: String(installer.id || ''),
            kind: String(installer.kind || 'download') as
              | 'brew'
              | 'npm'
              | 'go'
              | 'uv'
              | 'download',
            formula: installer.formula ? String(installer.formula) : undefined,
            package: installer.package ? String(installer.package) : undefined,
            bins: Array.isArray(installer.bins)
              ? installer.bins.filter((b) => typeof b === 'string')
              : undefined,
            label: installer.label ? String(installer.label) : undefined,
            url: installer.url ? String(installer.url) : undefined,
          };
        });
    }
  }

  return metadata;
}

/**
 * Validate skill name format
 */
export function isValidSkillName(name: string): boolean {
  // Skill names should be lowercase, alphanumeric with hyphens
  return /^[a-z][a-z0-9-]*$/.test(name);
}

/**
 * Normalize skill name for lookup
 */
export function normalizeSkillName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}
