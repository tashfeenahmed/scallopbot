/**
 * OpenClaw-compatible skill types
 *
 * Skills are markdown files (SKILL.md) with YAML frontmatter
 * that define agent capabilities.
 */

/**
 * Skill metadata for gating and configuration
 */
export interface SkillMetadata {
  openclaw?: {
    /** Always include skill regardless of gates */
    always?: boolean;
    /** Emoji icon for UI */
    emoji?: string;
    /** Platform restriction: darwin, linux, win32 */
    os?: string | string[];
    /** Requirements for skill to be available */
    requires?: {
      /** Required binaries on PATH */
      bins?: string[];
      /** At least one of these binaries must exist */
      anyBins?: string[];
      /** Required environment variables */
      env?: string[];
      /** Required config paths */
      config?: string[];
    };
    /** Primary environment variable for API key */
    primaryEnv?: string;
    /** Installation instructions */
    install?: SkillInstaller[];
  };
}

/**
 * Skill installer specification
 */
export interface SkillInstaller {
  id: string;
  kind: 'brew' | 'npm' | 'go' | 'uv' | 'download';
  formula?: string;
  package?: string;
  bins?: string[];
  label?: string;
  url?: string;
  /** Platform restriction for this installer */
  os?: string | string[];
}

/**
 * Skill frontmatter (YAML)
 */
export interface SkillFrontmatter {
  /** Unique skill identifier */
  name: string;
  /** What the skill does */
  description: string;
  /** Optional homepage URL */
  homepage?: string;
  /** Whether exposed as slash command (default: true) */
  'user-invocable'?: boolean;
  /** Exclude from model prompt (default: false) */
  'disable-model-invocation'?: boolean;
  /** Bypass model and invoke tool directly */
  'command-dispatch'?: 'tool';
  /** Tool to invoke when dispatch is enabled */
  'command-tool'?: string;
  /** Argument mode: raw passes unprocessed args */
  'command-arg-mode'?: 'raw';
  /** Metadata JSON object */
  metadata?: SkillMetadata;
  /** Keyword patterns that suggest this skill */
  triggers?: string[];
  /** Map of action names to script paths relative to skill folder */
  scripts?: { [action: string]: string };
  /** Input parameter schema for skill documentation */
  inputSchema?: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

/**
 * Parsed skill definition
 */
export interface Skill {
  /** Skill name/identifier */
  name: string;
  /** Skill description */
  description: string;
  /** Full path to SKILL.md file */
  path: string;
  /** Source directory (workspace, local, bundled, sdk) */
  source: 'workspace' | 'local' | 'bundled' | 'sdk';
  /** Parsed frontmatter */
  frontmatter: SkillFrontmatter;
  /** Markdown content (instructions for agent) */
  content: string;
  /** Whether skill is available (gates passed) */
  available: boolean;
  /** Reason if not available */
  unavailableReason?: string;
  /** Absolute path to scripts/ folder if it exists */
  scriptsDir?: string;
  /** Whether skill has executable scripts */
  hasScripts: boolean;
}

/**
 * Skill loader configuration
 */
export interface SkillLoaderConfig {
  /** Workspace skills directory */
  workspaceDir?: string;
  /** Local skills directory (default: ~/.scallopbot/skills) */
  localDir?: string;
  /** Extra directories to load skills from */
  extraDirs?: string[];
  /** Whether to watch for changes */
  watch?: boolean;
}

/**
 * Skill registry state
 */
export interface SkillRegistryState {
  /** All loaded skills */
  skills: Map<string, Skill>;
  /** Skills available for current session */
  availableSkills: Skill[];
  /** Last load timestamp */
  lastLoaded: number;
}

/**
 * Skill execution context
 */
export interface SkillContext {
  /** Arguments passed to skill */
  args?: string;
  /** Session ID */
  sessionId: string;
  /** Environment variables to inject */
  env?: Record<string, string>;
}

/**
 * Skill execution result
 */
export interface SkillResult {
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * Request to execute a skill script
 */
export interface SkillExecutionRequest {
  /** Name of the skill to execute */
  skillName: string;
  /** Optional action name (defaults to 'run' or 'default') */
  action?: string;
  /** Arguments to pass to script */
  args?: Record<string, unknown>;
  /** Working directory for script execution */
  cwd?: string;
}

/**
 * Result of executing a skill script
 */
export interface SkillExecutionResult {
  /** Whether the script executed successfully */
  success: boolean;
  /** stdout from script */
  output?: string;
  /** stderr or error message */
  error?: string;
  /** Exit code from script */
  exitCode?: number;
}
