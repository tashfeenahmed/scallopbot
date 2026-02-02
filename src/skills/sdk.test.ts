/**
 * Tests for ScallopBot Skill SDK
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  defineSkill,
  createSkill,
  SkillBuilder,
  SDKSkillRegistry,
  type SkillExecutionContext,
} from './sdk.js';
import type { Logger } from 'pino';

// Create mock logger
const createMockLogger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }) as unknown as Logger;

describe('defineSkill', () => {
  it('should create a skill builder', () => {
    const builder = defineSkill('test-skill', 'A test skill');

    expect(builder).toBeInstanceOf(SkillBuilder);
  });

  it('should build a basic skill definition', () => {
    const skillDef = defineSkill('test-skill', 'A test skill').build();

    expect(skillDef.skill.name).toBe('test-skill');
    expect(skillDef.skill.description).toBe('A test skill');
    expect(skillDef.skill.available).toBe(true);
    expect(skillDef.skill.frontmatter['user-invocable']).toBe(true);
  });

  it('should set user-invocable to false', () => {
    const skillDef = defineSkill('test-skill', 'A test skill')
      .userInvocable(false)
      .build();

    expect(skillDef.skill.frontmatter['user-invocable']).toBe(false);
  });

  it('should set disable-model-invocation', () => {
    const skillDef = defineSkill('test-skill', 'A test skill')
      .disableModelInvocation()
      .build();

    expect(skillDef.skill.frontmatter['disable-model-invocation']).toBe(true);
  });

  it('should configure command dispatch', () => {
    const skillDef = defineSkill('test-skill', 'A test skill')
      .commandDispatch('bash', 'raw')
      .build();

    expect(skillDef.skill.frontmatter['command-dispatch']).toBe('tool');
    expect(skillDef.skill.frontmatter['command-tool']).toBe('bash');
    expect(skillDef.skill.frontmatter['command-arg-mode']).toBe('raw');
  });

  it('should set required binaries', () => {
    const skillDef = defineSkill('test-skill', 'A test skill')
      .requiresBins('git', 'npm')
      .build();

    expect(skillDef.skill.frontmatter.metadata?.openclaw?.requires?.bins).toEqual([
      'git',
      'npm',
    ]);
  });

  it('should set required any-of binaries', () => {
    const skillDef = defineSkill('test-skill', 'A test skill')
      .requiresAnyBins('vim', 'nvim', 'code')
      .build();

    expect(skillDef.skill.frontmatter.metadata?.openclaw?.requires?.anyBins).toEqual([
      'vim',
      'nvim',
      'code',
    ]);
  });

  it('should set required environment variables', () => {
    const skillDef = defineSkill('test-skill', 'A test skill')
      .requiresEnv('GITHUB_TOKEN', 'OPENAI_API_KEY')
      .build();

    expect(skillDef.skill.frontmatter.metadata?.openclaw?.requires?.env).toEqual([
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
    ]);
  });

  it('should set OS restriction', () => {
    const skillDef = defineSkill('test-skill', 'A test skill')
      .forOS('darwin', 'linux')
      .build();

    expect(skillDef.skill.frontmatter.metadata?.openclaw?.os).toEqual([
      'darwin',
      'linux',
    ]);
  });

  it('should set single OS restriction', () => {
    const skillDef = defineSkill('test-skill', 'A test skill')
      .forOS('darwin')
      .build();

    expect(skillDef.skill.frontmatter.metadata?.openclaw?.os).toBe('darwin');
  });

  it('should set emoji', () => {
    const skillDef = defineSkill('test-skill', 'A test skill')
      .emoji('🚀')
      .build();

    expect(skillDef.skill.frontmatter.metadata?.openclaw?.emoji).toBe('🚀');
  });

  it('should set homepage', () => {
    const skillDef = defineSkill('test-skill', 'A test skill')
      .homepage('https://example.com')
      .build();

    expect(skillDef.skill.frontmatter.homepage).toBe('https://example.com');
  });

  it('should set instructions', () => {
    const skillDef = defineSkill('test-skill', 'A test skill')
      .instructions('# My Skill\n\nDo something cool.')
      .build();

    expect(skillDef.skill.content).toBe('# My Skill\n\nDo something cool.');
  });

  it('should chain multiple options', () => {
    const skillDef = defineSkill('advanced-skill', 'An advanced skill')
      .userInvocable()
      .requiresBins('git')
      .requiresEnv('GITHUB_TOKEN')
      .emoji('🔧')
      .homepage('https://github.com')
      .instructions('Use Git tools')
      .build();

    expect(skillDef.skill.name).toBe('advanced-skill');
    expect(skillDef.skill.frontmatter['user-invocable']).toBe(true);
    expect(skillDef.skill.frontmatter.metadata?.openclaw?.requires?.bins).toEqual(['git']);
    expect(skillDef.skill.frontmatter.metadata?.openclaw?.requires?.env).toEqual([
      'GITHUB_TOKEN',
    ]);
    expect(skillDef.skill.frontmatter.metadata?.openclaw?.emoji).toBe('🔧');
    expect(skillDef.skill.frontmatter.homepage).toBe('https://github.com');
    expect(skillDef.skill.content).toBe('Use Git tools');
  });
});

describe('Skill execution', () => {
  it('should execute handler with context', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, output: 'Done!' });

    const skillDef = defineSkill('test-skill', 'A test skill')
      .onExecute(handler)
      .build();

    const result = await skillDef.execute(
      { sessionId: 'session-1', args: 'arg1 arg2' },
      createMockLogger()
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe('Done!');
    expect(handler).toHaveBeenCalled();
  });

  it('should provide parseArgs in context', async () => {
    let capturedContext: SkillExecutionContext | null = null;

    const skillDef = defineSkill('test-skill', 'A test skill')
      .onExecute(async (ctx) => {
        capturedContext = ctx;
        return { success: true };
      })
      .build();

    await skillDef.execute(
      { sessionId: 'session-1', args: 'key1=value1 key2="quoted value"' },
      createMockLogger()
    );

    expect(capturedContext).not.toBeNull();
    const parsed = capturedContext!.parseArgs();
    expect(parsed.key1).toBe('value1');
    expect(parsed.key2).toBe('quoted value');
  });

  it('should provide parseArgsPositional in context', async () => {
    let capturedContext: SkillExecutionContext | null = null;

    const skillDef = defineSkill('test-skill', 'A test skill')
      .onExecute(async (ctx) => {
        capturedContext = ctx;
        return { success: true };
      })
      .build();

    await skillDef.execute(
      { sessionId: 'session-1', args: 'first "second arg" third' },
      createMockLogger()
    );

    expect(capturedContext).not.toBeNull();
    const args = capturedContext!.parseArgsPositional();
    expect(args).toEqual(['first', 'second arg', 'third']);
  });

  it('should handle execution errors', async () => {
    const skillDef = defineSkill('test-skill', 'A test skill')
      .onExecute(async () => {
        throw new Error('Something went wrong');
      })
      .build();

    const result = await skillDef.execute(
      { sessionId: 'session-1' },
      createMockLogger()
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Something went wrong');
  });

  it('should return error if no handler', async () => {
    const skillDef = defineSkill('test-skill', 'A test skill').build();

    const result = await skillDef.execute(
      { sessionId: 'session-1' },
      createMockLogger()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('no execution handler');
  });
});

describe('createSkill', () => {
  it('should create skill with handler in one call', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, output: 'Quick!' });

    const skillDef = createSkill('quick-skill', 'A quick skill', handler);

    expect(skillDef.skill.name).toBe('quick-skill');

    const result = await skillDef.execute(
      { sessionId: 'session-1' },
      createMockLogger()
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe('Quick!');
  });

  it('should accept options', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true });

    const skillDef = createSkill('quick-skill', 'A quick skill', handler, {
      emoji: '⚡',
      requiredBins: ['node'],
      userInvocable: false,
    });

    expect(skillDef.skill.frontmatter.metadata?.openclaw?.emoji).toBe('⚡');
    expect(skillDef.skill.frontmatter.metadata?.openclaw?.requires?.bins).toEqual([
      'node',
    ]);
    expect(skillDef.skill.frontmatter['user-invocable']).toBe(false);
  });
});

describe('SDKSkillRegistry', () => {
  let registry: SDKSkillRegistry;

  beforeEach(() => {
    registry = new SDKSkillRegistry();
  });

  it('should register a skill', () => {
    const skillDef = defineSkill('test-skill', 'A test skill').build();

    registry.register(skillDef);

    expect(registry.has('test-skill')).toBe(true);
    expect(registry.size).toBe(1);
  });

  it('should get a registered skill', () => {
    const skillDef = defineSkill('test-skill', 'A test skill').build();

    registry.register(skillDef);
    const retrieved = registry.get('test-skill');

    expect(retrieved).toBe(skillDef);
  });

  it('should return undefined for unknown skill', () => {
    const retrieved = registry.get('unknown');

    expect(retrieved).toBeUndefined();
  });

  it('should get all registered skills', () => {
    registry.register(defineSkill('skill-1', 'First').build());
    registry.register(defineSkill('skill-2', 'Second').build());

    const all = registry.getAll();

    expect(all).toHaveLength(2);
  });

  it('should get available skills', () => {
    registry.register(defineSkill('available', 'Available').build());
    registry.register(
      defineSkill('unavailable', 'Unavailable')
        .requiresEnv('NONEXISTENT_ENV_VAR_XYZ_123')
        .build()
    );

    const available = registry.getAvailable();

    expect(available).toHaveLength(1);
    expect(available[0].skill.name).toBe('available');
  });

  it('should get user-invocable skills', () => {
    registry.register(defineSkill('invocable', 'Invocable').userInvocable(true).build());
    registry.register(
      defineSkill('not-invocable', 'Not invocable').userInvocable(false).build()
    );

    const invocable = registry.getUserInvocable();

    expect(invocable).toHaveLength(1);
    expect(invocable[0].skill.name).toBe('invocable');
  });

  it('should remove a skill', () => {
    registry.register(defineSkill('test-skill', 'Test').build());
    expect(registry.has('test-skill')).toBe(true);

    const removed = registry.remove('test-skill');

    expect(removed).toBe(true);
    expect(registry.has('test-skill')).toBe(false);
  });

  it('should clear all skills', () => {
    registry.register(defineSkill('skill-1', 'First').build());
    registry.register(defineSkill('skill-2', 'Second').build());
    expect(registry.size).toBe(2);

    registry.clear();

    expect(registry.size).toBe(0);
  });
});

describe('Gate checking', () => {
  it('should mark skill unavailable if required bin is missing', () => {
    const skillDef = defineSkill('test-skill', 'Test')
      .requiresBins('nonexistent-binary-xyz-123')
      .build();

    expect(skillDef.skill.available).toBe(false);
    expect(skillDef.skill.unavailableReason).toContain('nonexistent-binary-xyz-123');
  });

  it('should mark skill unavailable if required env is missing', () => {
    const skillDef = defineSkill('test-skill', 'Test')
      .requiresEnv('NONEXISTENT_ENV_VAR_XYZ_123')
      .build();

    expect(skillDef.skill.available).toBe(false);
    expect(skillDef.skill.unavailableReason).toContain('NONEXISTENT_ENV_VAR_XYZ_123');
  });

  it('should pass if required env exists', () => {
    // PATH always exists
    const skillDef = defineSkill('test-skill', 'Test').requiresEnv('PATH').build();

    expect(skillDef.skill.available).toBe(true);
  });

  it('should fail execution if skill is unavailable', async () => {
    const skillDef = defineSkill('test-skill', 'Test')
      .requiresEnv('NONEXISTENT_ENV_VAR_XYZ_123')
      .onExecute(async () => ({ success: true }))
      .build();

    const result = await skillDef.execute(
      { sessionId: 'session-1' },
      createMockLogger()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('NONEXISTENT_ENV_VAR_XYZ_123');
  });
});

describe('SDK source type', () => {
  it('should mark SDK skills with source "sdk"', () => {
    const skillDef = defineSkill('test-skill', 'Test').build();

    expect(skillDef.skill.source).toBe('sdk');
  });

  it('should have path prefix "sdk:"', () => {
    const skillDef = defineSkill('test-skill', 'Test').build();

    expect(skillDef.skill.path).toBe('sdk:test-skill');
  });
});
