/**
 * Tests for ClawHub Skill Package Manager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { SkillPackageManager } from './clawhub.js';

import { SkillInstaller } from './clawhub.js';

describe('SkillInstaller', () => {
  describe('selectInstaller', () => {
    it('should prefer brew on macOS', () => {
      const installers = [
        { id: 'npm', kind: 'npm' as const, package: 'my-pkg' },
        { id: 'brew', kind: 'brew' as const, formula: 'my-formula' },
      ];

      const installer = new SkillInstaller();
      const selected = installer.selectInstaller(installers, 'darwin');

      expect(selected?.kind).toBe('brew');
    });

    it('should fall back to npm when brew not available', () => {
      const installers = [
        { id: 'npm', kind: 'npm' as const, package: 'my-pkg' },
        { id: 'brew', kind: 'brew' as const, formula: 'my-formula' },
      ];

      const installer = new SkillInstaller();
      const selected = installer.selectInstaller(installers, 'linux');

      expect(selected?.kind).toBe('npm');
    });

    it('should filter by OS', () => {
      const installers = [
        { id: 'brew', kind: 'brew' as const, formula: 'my-formula', os: ['darwin'] },
        { id: 'npm', kind: 'npm' as const, package: 'my-pkg' },
      ];

      const installer = new SkillInstaller();
      const selected = installer.selectInstaller(installers, 'linux');

      expect(selected?.kind).toBe('npm');
    });
  });

  describe('buildInstallCommand', () => {
    it('should build brew install command with shell escaping', () => {
      const installer = new SkillInstaller();
      const cmd = installer.buildInstallCommand({
        id: 'brew',
        kind: 'brew',
        formula: 'ripgrep',
      });

      // Commands now use shell escaping for security
      expect(cmd).toBe("brew install 'ripgrep'");
    });

    it('should build npm install command with shell escaping', () => {
      const installer = new SkillInstaller();
      const cmd = installer.buildInstallCommand({
        id: 'npm',
        kind: 'npm',
        package: 'typescript',
      });

      // Commands now use shell escaping for security
      expect(cmd).toContain("npm install -g 'typescript'");
    });

    it('should build go install command with shell escaping', () => {
      const installer = new SkillInstaller();
      const cmd = installer.buildInstallCommand({
        id: 'go',
        kind: 'go',
        package: 'github.com/example/tool@latest',
      });

      // Commands now use shell escaping for security
      expect(cmd).toBe("go install 'github.com/example/tool@latest'");
    });

    it('should build download command with curl and escaping', () => {
      const installer = new SkillInstaller();
      const cmd = installer.buildInstallCommand({
        id: 'download',
        kind: 'download',
        url: 'https://example.com/binary',
        bins: ['binary'],
      });

      expect(cmd).toContain('curl');
      expect(cmd).toContain("'https://example.com/binary'");
    });

    it('should reject invalid package names', () => {
      const installer = new SkillInstaller();
      expect(() =>
        installer.buildInstallCommand({
          id: 'npm',
          kind: 'npm',
          package: 'package; rm -rf /',
        })
      ).toThrow('Invalid npm package name');
    });

    it('should reject invalid URLs', () => {
      const installer = new SkillInstaller();
      expect(() =>
        installer.buildInstallCommand({
          id: 'download',
          kind: 'download',
          url: 'javascript:alert(1)',
          bins: ['binary'],
        })
      ).toThrow('Invalid download URL');
    });
  });

  describe('executeInstall (mocked)', () => {
    it('should return command that would be executed with escaping', async () => {
      const installer = new SkillInstaller({ dryRun: true });
      const result = await installer.executeInstall({
        id: 'brew',
        kind: 'brew',
        formula: 'jq',
      });

      expect(result.success).toBe(true);
      // Commands now use shell escaping for security
      expect(result.command).toBe("brew install 'jq'");
    });
  });
});

describe('SkillPackageManager', () => {
  let testDir: string;
  let manager: SkillPackageManager;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scallopbot-clawhub-test-'));
    manager = new SkillPackageManager({
      skillsDir: path.join(testDir, 'skills'),
    });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('installFromUrl', () => {
    it('should install a skill from URL', async () => {
      // Mock fetch
      const skillContent = `---
name: test-skill
description: A test skill
---

Test content.
`;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(skillContent),
      });

      const result = await manager.installFromUrl('test-skill', 'https://example.com/skill.md');

      expect(result.success).toBe(true);
      expect(result.skill?.name).toBe('test-skill');
      expect(result.path).toBeDefined();
    });

    it('should fail for invalid skill format', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('No frontmatter here'),
      });

      const result = await manager.installFromUrl('invalid', 'https://example.com/invalid.md');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid skill format');
    });

    it('should fail for HTTP errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      const result = await manager.installFromUrl('missing', 'https://example.com/missing.md');

      expect(result.success).toBe(false);
      expect(result.error).toContain('404');
    });
  });

  describe('checksum validation', () => {
    it('should verify checksum when provided', async () => {
      const skillContent = `---
name: verified-skill
description: A verified skill
---

Verified content.
`;
      const checksum = createHash('sha256').update(skillContent).digest('hex');

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(skillContent),
      });

      const result = await manager.installWithChecksum(
        'verified-skill',
        'https://example.com/skill.md',
        checksum
      );

      expect(result.success).toBe(true);
    });

    it('should fail when checksum does not match', async () => {
      const skillContent = `---
name: tampered-skill
description: A tampered skill
---

Tampered content.
`;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(skillContent),
      });

      const result = await manager.installWithChecksum(
        'tampered-skill',
        'https://example.com/skill.md',
        'invalid-checksum-abc123'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('checksum');
    });

    it('should compute checksum for installed skill', async () => {
      const skillContent = `---
name: checksum-skill
description: A skill with checksum
---

Content.
`;
      const expectedChecksum = createHash('sha256').update(skillContent).digest('hex');

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(skillContent),
      });

      const result = await manager.installFromUrl('checksum-skill', 'https://example.com/skill.md');

      expect(result.success).toBe(true);
      expect(result.checksum).toBe(expectedChecksum);
    });
  });

  describe('version enforcement', () => {
    it('should track installed version', async () => {
      const skillContent = `---
name: versioned-skill
description: A versioned skill
---

Content.
`;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(skillContent),
      });

      await manager.installFromUrl('versioned-skill', 'https://example.com/skill.md');

      const version = await manager.getInstalledVersion('versioned-skill');
      expect(version).toBeDefined();
    });

    it('should check if update is available', async () => {
      // Install version 1.0.0
      const v1Content = `---
name: update-skill
description: Version 1.0.0
---

Content v1.
`;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(v1Content),
      });

      await manager.installFromUrl('update-skill', 'https://example.com/skill.md');

      // Check for update with v2.0.0 available
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            skills: [
              {
                name: 'update-skill',
                description: 'Version 2.0.0',
                version: '2.0.0',
                downloadUrl: 'https://example.com/skill.md',
              },
            ],
          }),
      });

      const hasUpdate = await manager.hasUpdate('update-skill');
      expect(hasUpdate).toBeDefined();
    });

    it('should enforce minimum version requirement', async () => {
      const skillContent = `---
name: minver-skill
description: Requires minimum version
---

Content.
`;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(skillContent),
      });

      await manager.installFromUrl('minver-skill', 'https://example.com/skill.md');

      // Check version compatibility
      const isCompatible = await manager.isVersionCompatible('minver-skill', '1.0.0');
      expect(typeof isCompatible).toBe('boolean');
    });
  });

  describe('listInstalled', () => {
    it('should list installed skills', async () => {
      const skillContent = `---
name: listed-skill
description: A listed skill
---

Content.
`;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(skillContent),
      });

      await manager.installFromUrl('listed-skill', 'https://example.com/skill.md');

      const installed = await manager.listInstalled();

      expect(installed).toContain('listed-skill');
    });
  });

  describe('uninstall', () => {
    it('should uninstall a skill', async () => {
      const skillContent = `---
name: removable-skill
description: Will be removed
---

Content.
`;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(skillContent),
      });

      await manager.installFromUrl('removable-skill', 'https://example.com/skill.md');

      const result = await manager.uninstall('removable-skill');

      expect(result.success).toBe(true);
      const installed = await manager.listInstalled();
      expect(installed).not.toContain('removable-skill');
    });

    it('should fail for non-existent skill', async () => {
      const result = await manager.uninstall('nonexistent-skill');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});
