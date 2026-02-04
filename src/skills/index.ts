/**
 * Skills Module
 *
 * Provides two skill systems:
 *
 * 1. Original ScallopBot format (skill.ts):
 *    - Uses markdown H1/H2/H3 sections
 *    - Sections: Triggers, Actions, Metadata
 *    - Good for simple skills
 *
 * 2. OpenClaw-compatible format (parser.ts, loader.ts, registry.ts):
 *    - Uses YAML frontmatter in SKILL.md files
 *    - Supports gating (bins, env, config, OS)
 *    - Full OpenClaw skill compatibility
 */

// Original ScallopBot skill system
export {
  parseSkillMd,
  SkillRegistry as LegacySkillRegistry,
  SkillLoader as LegacySkillLoader,
  ClawHubClient,
  type SkillDefinition,
  type SkillAction,
  type SkillMetadata as LegacySkillMetadata,
  type SkillLoaderOptions,
  type ClawHubClientOptions,
  type ClawHubSkillInfo,
} from './skill.js';

// OpenClaw-compatible skill system
export type {
  Skill,
  SkillFrontmatter,
  SkillMetadata,
  SkillInstaller,
  SkillLoaderConfig,
  SkillRegistryState,
  SkillContext,
  SkillResult,
  SkillExecutionRequest,
  SkillExecutionResult,
} from './types.js';

export {
  parseFrontmatter,
  SkillParseError,
  isValidSkillName,
  normalizeSkillName,
} from './parser.js';
export type { ParsedSkill } from './parser.js';

export { SkillLoader, createSkillLoader, checkGates } from './loader.js';
export { SkillRegistry, createSkillRegistry } from './registry.js';
export type { SkillHandler } from './registry.js';

// Skill executor for running scripts
export { SkillExecutor, createSkillExecutor } from './executor.js';

// Skill package manager for downloading from registries
export { SkillPackageManager, createSkillPackageManager } from './clawhub.js';
export type { SkillPackageManagerOptions, SkillPackage, InstallResult } from './clawhub.js';

// Native SDK for programmatic skill definition
export {
  defineSkill,
  createSkill,
  SkillBuilder,
  SDKSkillRegistry,
  sdkSkillRegistry,
} from './sdk.js';
export type {
  SkillHandler as SDKSkillHandler,
  SkillDefinition as SDKSkillDefinition,
  SkillExecutionContext,
  SkillBuilderOptions,
} from './sdk.js';
