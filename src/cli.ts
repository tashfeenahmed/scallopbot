#!/usr/bin/env node

import { Command } from 'commander';
import * as readline from 'readline';
import { pino } from 'pino';
import { loadConfig, resetConfig } from './config/index.js';
import { Gateway, setupGracefulShutdown } from './gateway/index.js';
import { createLogger } from './utils/logger.js';
import { SkillPackageManager, SkillInstaller } from './skills/clawhub.js';
import { SkillLoader } from './skills/loader.js';
import { migrateJsonlToSqlite, verifyMigration, rollbackMigration } from './memory/migrate.js';

const VERSION = '0.1.0';

const program = new Command();

program
  .name('scallopbot')
  .description('Personal AI assistant accessible via Telegram')
  .version(VERSION);

// Start command - runs the gateway server
program
  .command('start')
  .description('Start the ScallopBot gateway server')
  .option('-v, --verbose', 'Enable verbose logging')
  .action(async (options) => {
    try {
      resetConfig();
      const config = loadConfig();

      if (options.verbose) {
        config.logging.level = 'debug';
      }

      const logger = createLogger(config.logging);

      logger.info({ version: VERSION }, 'Starting ScallopBot...');

      const gateway = new Gateway({ config, logger });
      setupGracefulShutdown(gateway, logger);

      await gateway.initialize();
      await gateway.start();

      logger.info('ScallopBot is running. Press Ctrl+C to stop.');
    } catch (error) {
      console.error('Failed to start ScallopBot:', (error as Error).message);
      process.exit(1);
    }
  });

// Chat command - interactive CLI chat
program
  .command('chat')
  .description('Start an interactive chat session')
  .option('-s, --session <id>', 'Resume existing session')
  .action(async (options) => {
    try {
      resetConfig();
      const config = loadConfig();
      const logger = pino({ level: 'silent' });

      const gateway = new Gateway({ config, logger });
      await gateway.initialize();

      const sessionManager = gateway.getSessionManager();
      const agent = gateway.getAgent();

      // Get or create session
      let sessionId: string;
      if (options.session) {
        const existing = await sessionManager.getSession(options.session);
        if (!existing) {
          console.error(`Session not found: ${options.session}`);
          process.exit(1);
        }
        sessionId = options.session;
        console.log(`Resuming session: ${sessionId}`);
      } else {
        const session = await sessionManager.createSession({ channelId: 'cli' });
        sessionId = session.id;
        console.log(`Created new session: ${sessionId}`);
      }

      console.log('ScallopBot Chat - Type your messages below. Use Ctrl+C to exit.\n');

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'You: ',
      });

      rl.prompt();

      rl.on('line', async (line) => {
        const input = line.trim();
        if (!input) {
          rl.prompt();
          return;
        }

        try {
          console.log('Assistant: (thinking...)\n');
          const result = await agent.processMessage(sessionId, input);
          console.log(`Assistant: ${result.response}\n`);
          console.log(
            `[Tokens: ${result.tokenUsage.inputTokens} in, ${result.tokenUsage.outputTokens} out]\n`
          );
        } catch (error) {
          console.error(`Error: ${(error as Error).message}\n`);
        }

        rl.prompt();
      });

      rl.on('close', () => {
        console.log('\nGoodbye!');
        process.exit(0);
      });
    } catch (error) {
      console.error('Failed to start chat:', (error as Error).message);
      process.exit(1);
    }
  });

// Config command - show current configuration
program
  .command('config')
  .description('Show current configuration')
  .option('--json', 'Output as JSON')
  .action((options) => {
    try {
      resetConfig();
      const config = loadConfig();

      // Mask sensitive values
      const safeConfig = {
        providers: {
          anthropic: {
            apiKey: config.providers.anthropic.apiKey ? '***' : '(not set)',
            model: config.providers.anthropic.model,
          },
        },
        channels: {
          telegram: {
            enabled: config.channels.telegram.enabled,
            botToken: config.channels.telegram.botToken ? '***' : '(not set)',
          },
        },
        agent: config.agent,
        logging: config.logging,
      };

      if (options.json) {
        console.log(JSON.stringify(safeConfig, null, 2));
      } else {
        console.log('ScallopBot Configuration:');
        console.log('');
        console.log('Providers:');
        console.log(
          `  Anthropic: ${safeConfig.providers.anthropic.apiKey} (model: ${safeConfig.providers.anthropic.model})`
        );
        console.log('');
        console.log('Channels:');
        console.log(
          `  Telegram: ${safeConfig.channels.telegram.enabled ? 'enabled' : 'disabled'} (token: ${safeConfig.channels.telegram.botToken})`
        );
        console.log('');
        console.log('Agent:');
        console.log(`  Workspace: ${safeConfig.agent.workspace}`);
        console.log(`  Max Iterations: ${safeConfig.agent.maxIterations}`);
        console.log('');
        console.log('Logging:');
        console.log(`  Level: ${safeConfig.logging.level}`);
      }
    } catch (error) {
      console.error('Failed to load config:', (error as Error).message);
      process.exit(1);
    }
  });

// Version command
program
  .command('version')
  .description('Show version information')
  .action(() => {
    console.log(`ScallopBot v${VERSION}`);
  });

// Skill command group
const skillCommand = program
  .command('skill')
  .description('Manage skills');

// skill search
skillCommand
  .command('search <query>')
  .description('Search for skills on ClawHub (clawhub.ai)')
  .option('-l, --limit <number>', 'Maximum results to show', '10')
  .action(async (query: string, options: { limit: string }) => {
    try {
      const manager = new SkillPackageManager();
      const limit = parseInt(options.limit, 10) || 10;

      console.log(`Searching ClawHub for "${query}"...\n`);
      const results = await manager.searchClawHub(query, limit);

      if (results.length === 0) {
        console.log(`No skills found matching "${query}"`);
        console.log('\nTry browsing skills at: https://clawhub.ai/skills');
        return;
      }

      console.log(`Found ${results.length} skill(s):\n`);
      for (const skill of results) {
        const stars = skill.stats?.stars ? `★${skill.stats.stars}` : '';
        const downloads = skill.stats?.downloads ? `↓${skill.stats.downloads}` : '';
        const badges = [stars, downloads].filter(Boolean).join(' ');
        const owner = skill.owner?.handle ? `by ${skill.owner.handle}` : '';

        console.log(`  ${skill.slug} ${badges}`);
        console.log(`    ${skill.displayName} ${owner}`);
        console.log(`    ${skill.summary || '(no description)'}`);
        console.log('');
      }

      console.log(`Install with: scallopbot skill install <slug>`);
    } catch (error) {
      console.error('Search failed:', (error as Error).message);
      process.exit(1);
    }
  });

// skill install
skillCommand
  .command('install <slug>')
  .description('Install a skill from ClawHub (clawhub.ai)')
  .option('--url <url>', 'Install from a specific URL instead of ClawHub')
  .option('-v, --version <version>', 'Install a specific version')
  .option('--deps', 'Also install skill dependencies')
  .action(async (slug: string, options: { url?: string; version?: string; deps?: boolean }) => {
    try {
      const manager = new SkillPackageManager();

      console.log(`Installing skill: ${slug}...`);

      let result;
      if (options.url) {
        // Install from direct URL
        result = await manager.installFromUrl(slug, options.url);
      } else {
        // Install from ClawHub (default)
        result = await manager.installFromClawHub(slug, options.version);
      }

      if (result.success) {
        console.log(`\n✓ Installed ${result.skill?.name} to ${result.path}`);
        if (result.checksum) {
          console.log(`  Checksum: ${result.checksum.slice(0, 16)}...`);
        }
        if (result.skill?.hasScripts) {
          console.log(`  Scripts: Yes (executable skill)`);
        } else {
          console.log(`  Scripts: No (documentation skill - provides context to LLM)`);
        }

        // Install dependencies if requested
        if (options.deps && result.skill?.frontmatter.metadata?.openclaw?.install) {
          console.log('\nInstalling dependencies...');
          const installer = new SkillInstaller();
          const depResults = await installer.installDependencies(
            result.skill.frontmatter.metadata.openclaw.install
          );
          for (const depResult of depResults) {
            if (depResult.success) {
              console.log(`  ✓ ${depResult.command || 'Dependencies installed'}`);
            } else {
              console.log(`  ✗ ${depResult.error}`);
            }
          }
        }

        console.log('\nRestart ScallopBot to use the new skill.');
      } else {
        console.error(`\n✗ Installation failed: ${result.error}`);
        process.exit(1);
      }
    } catch (error) {
      console.error('Install failed:', (error as Error).message);
      process.exit(1);
    }
  });

// skill uninstall
skillCommand
  .command('uninstall <name>')
  .description('Uninstall a skill')
  .action(async (name: string) => {
    try {
      const manager = new SkillPackageManager();
      const result = await manager.uninstall(name);

      if (result.success) {
        console.log(`✓ Uninstalled ${name}`);
      } else {
        console.error(`✗ Uninstall failed: ${result.error}`);
        process.exit(1);
      }
    } catch (error) {
      console.error('Uninstall failed:', (error as Error).message);
      process.exit(1);
    }
  });

// skill list
skillCommand
  .command('list')
  .description('List installed skills')
  .option('--available', 'Show only available skills (gates passed)')
  .action(async (options: { available?: boolean }) => {
    try {
      resetConfig();
      const config = loadConfig();
      const loader = new SkillLoader({
        workspaceDir: config.agent.workspace,
      });

      const skills = await loader.loadAll();

      const filtered = options.available
        ? skills.filter((s) => s.available)
        : skills;

      if (filtered.length === 0) {
        console.log('No skills installed.');
        return;
      }

      console.log(`Installed skills (${filtered.length}):\n`);
      for (const skill of filtered) {
        const status = skill.available ? '✓' : '✗';
        const emoji = skill.frontmatter.metadata?.openclaw?.emoji || '';
        console.log(`  ${status} ${skill.name} ${emoji}`);
        console.log(`    ${skill.description}`);
        console.log(`    Source: ${skill.source}`);
        if (!skill.available && skill.unavailableReason) {
          console.log(`    Unavailable: ${skill.unavailableReason}`);
        }
        console.log('');
      }
    } catch (error) {
      console.error('List failed:', (error as Error).message);
      process.exit(1);
    }
  });

// skill update
skillCommand
  .command('update [name]')
  .description('Update a skill or all skills')
  .action(async (name?: string) => {
    try {
      const manager = new SkillPackageManager();

      if (name) {
        console.log(`Updating ${name}...`);
        const result = await manager.update(name);
        if (result.success) {
          console.log(`✓ Updated ${name}`);
        } else {
          console.error(`✗ Update failed: ${result.error}`);
          process.exit(1);
        }
      } else {
        console.log('Updating all skills...');
        const results = await manager.updateAll();
        let success = 0;
        let failed = 0;
        for (const [skillName, result] of results) {
          if (result.success) {
            console.log(`  ✓ ${skillName}`);
            success++;
          } else {
            console.log(`  ✗ ${skillName}: ${result.error}`);
            failed++;
          }
        }
        console.log(`\nUpdated: ${success}, Failed: ${failed}`);
      }
    } catch (error) {
      console.error('Update failed:', (error as Error).message);
      process.exit(1);
    }
  });

// skill info (ClawHub)
skillCommand
  .command('hub <slug>')
  .description('Get skill info from ClawHub')
  .action(async (slug: string) => {
    try {
      const manager = new SkillPackageManager();

      console.log(`Fetching info for "${slug}" from ClawHub...\n`);

      const skill = await manager.getClawHubSkill(slug);
      if (!skill) {
        console.error(`Skill "${slug}" not found on ClawHub`);
        process.exit(1);
      }

      console.log(`Skill: ${skill.displayName}`);
      console.log(`Slug: ${skill.slug}`);
      console.log(`Summary: ${skill.summary || '(none)'}`);

      if (skill.owner) {
        console.log(`Owner: ${skill.owner.displayName} (@${skill.owner.handle})`);
      }

      if (skill.stats) {
        console.log(`\nStats:`);
        console.log(`  Downloads: ${skill.stats.downloads || 0}`);
        console.log(`  Stars: ${skill.stats.stars || 0}`);
        if (skill.stats.versions) {
          console.log(`  Versions: ${skill.stats.versions}`);
        }
      }

      if (skill.badges) {
        const badges = [];
        if (skill.badges.official) badges.push('Official');
        if (skill.badges.highlighted) badges.push('Highlighted');
        if (badges.length > 0) {
          console.log(`\nBadges: ${badges.join(', ')}`);
        }
      }

      // Get versions
      const versions = await manager.getClawHubVersions(slug);
      if (versions.length > 0) {
        console.log(`\nVersions:`);
        for (const v of versions.slice(0, 5)) {
          const date = new Date(v.createdAt).toLocaleDateString();
          console.log(`  ${v.version} (${date})`);
          if (v.changelog) {
            console.log(`    ${v.changelog.slice(0, 80)}${v.changelog.length > 80 ? '...' : ''}`);
          }
        }
        if (versions.length > 5) {
          console.log(`  ... and ${versions.length - 5} more`);
        }
      }

      console.log(`\nView on ClawHub: https://clawhub.ai/skills/${slug}`);
      console.log(`Install: scallopbot skill install ${slug}`);
    } catch (error) {
      console.error('Failed to get skill info:', (error as Error).message);
      process.exit(1);
    }
  });

// skill versions (ClawHub)
skillCommand
  .command('versions <slug>')
  .description('List available versions of a skill on ClawHub')
  .action(async (slug: string) => {
    try {
      const manager = new SkillPackageManager();

      console.log(`Fetching versions for "${slug}" from ClawHub...\n`);

      const versions = await manager.getClawHubVersions(slug);

      if (versions.length === 0) {
        console.log(`No versions found for "${slug}"`);
        console.log('The skill may not exist or have no published versions.');
        return;
      }

      console.log(`Available versions for ${slug}:\n`);

      for (const ver of versions) {
        // createdAt is in milliseconds
        const date = new Date(ver.createdAt).toLocaleDateString();
        console.log(`  v${ver.version} (${date})`);
        if (ver.changelog) {
          // Show first line of changelog
          const firstLine = ver.changelog.split('\n')[0].slice(0, 100);
          console.log(`    ${firstLine}${ver.changelog.length > 100 ? '...' : ''}`);
        }
      }

      console.log(`\nInstall specific version: scallopbot skill install ${slug} -v <version>`);
    } catch (error) {
      console.error('Failed to get versions:', (error as Error).message);
      process.exit(1);
    }
  });

// skill info (local)
skillCommand
  .command('info <name>')
  .description('Show detailed information about an installed skill')
  .action(async (name: string) => {
    try {
      resetConfig();
      const config = loadConfig();
      const loader = new SkillLoader({
        workspaceDir: config.agent.workspace,
      });

      await loader.loadAll();
      const skill = loader.getSkill(name);

      if (!skill) {
        console.error(`Skill not found: ${name}`);
        process.exit(1);
      }

      const meta = skill.frontmatter.metadata?.openclaw;

      console.log(`\nSkill: ${skill.name}`);
      if (meta?.emoji) console.log(`Emoji: ${meta.emoji}`);
      console.log(`Description: ${skill.description}`);
      console.log(`Source: ${skill.source}`);
      console.log(`Path: ${skill.path}`);
      console.log(`Available: ${skill.available ? 'Yes' : 'No'}`);
      if (!skill.available && skill.unavailableReason) {
        console.log(`  Reason: ${skill.unavailableReason}`);
      }
      console.log(`User Invocable: ${skill.frontmatter['user-invocable'] !== false}`);
      console.log(`Model Invocable: ${!skill.frontmatter['disable-model-invocation']}`);

      if (meta?.requires) {
        console.log('\nRequirements:');
        if (meta.requires.bins?.length) {
          console.log(`  Binaries: ${meta.requires.bins.join(', ')}`);
        }
        if (meta.requires.env?.length) {
          console.log(`  Environment: ${meta.requires.env.join(', ')}`);
        }
        if (meta.requires.config?.length) {
          console.log(`  Config files: ${meta.requires.config.join(', ')}`);
        }
      }

      if (meta?.install?.length) {
        console.log('\nInstallation options:');
        for (const inst of meta.install) {
          console.log(`  - ${inst.kind}: ${inst.formula || inst.package || inst.url || 'N/A'}`);
        }
      }

      if (skill.frontmatter.homepage) {
        console.log(`\nHomepage: ${skill.frontmatter.homepage}`);
      }

      console.log('');
    } catch (error) {
      console.error('Info failed:', (error as Error).message);
      process.exit(1);
    }
  });

// Migrate command group for ScallopMemory
const migrateCommand = program
  .command('migrate')
  .description('Memory migration tools (JSONL -> SQLite)');

// migrate run
migrateCommand
  .command('run')
  .description('Migrate memories from JSONL to SQLite (ScallopMemory)')
  .option('-s, --source <path>', 'Source JSONL file path', 'memories.jsonl')
  .option('-d, --dest <path>', 'Destination SQLite database path', 'memories.db')
  .option('--no-backup', 'Skip creating backup of source file')
  .option('-u, --user <id>', 'Default user ID for memories without one', 'default')
  .action(async (options: { source: string; dest: string; backup: boolean; user: string }) => {
    try {
      resetConfig();
      const config = loadConfig();
      const workspace = config.agent.workspace;

      // Resolve paths relative to workspace
      const jsonlPath = options.source.startsWith('/')
        ? options.source
        : `${workspace}/${options.source}`;
      const dbPath = options.dest.startsWith('/')
        ? options.dest
        : `${workspace}/${options.dest}`;

      console.log('ScallopMemory Migration: JSONL -> SQLite');
      console.log('========================================');
      console.log(`Source: ${jsonlPath}`);
      console.log(`Target: ${dbPath}`);
      console.log(`Backup: ${options.backup ? 'Yes' : 'No'}`);
      console.log('');

      const result = await migrateJsonlToSqlite({
        jsonlPath,
        dbPath,
        createBackup: options.backup,
        defaultUserId: options.user,
      });

      if (result.success) {
        console.log('✓ Migration successful!');
        console.log(`  Imported: ${result.memoriesImported}`);
        console.log(`  Skipped: ${result.memoriesSkipped}`);
        if (result.backupPath) {
          console.log(`  Backup: ${result.backupPath}`);
        }
        console.log('');
        console.log('To enable ScallopMemory, set:');
        console.log('  USE_SCALLOP_MEMORY=true');
        console.log(`  MEMORY_DB_PATH=${options.dest}`);
      } else {
        console.error('✗ Migration failed!');
        for (const error of result.errors) {
          console.error(`  - ${error}`);
        }
        process.exit(1);
      }
    } catch (error) {
      console.error('Migration error:', (error as Error).message);
      process.exit(1);
    }
  });

// migrate verify
migrateCommand
  .command('verify')
  .description('Verify migration by comparing entry counts')
  .option('-s, --source <path>', 'Source JSONL file path', 'memories.jsonl')
  .option('-d, --dest <path>', 'Destination SQLite database path', 'memories.db')
  .action(async (options: { source: string; dest: string }) => {
    try {
      resetConfig();
      const config = loadConfig();
      const workspace = config.agent.workspace;

      const jsonlPath = options.source.startsWith('/')
        ? options.source
        : `${workspace}/${options.source}`;
      const dbPath = options.dest.startsWith('/')
        ? options.dest
        : `${workspace}/${options.dest}`;

      console.log('Verifying migration...');
      const result = await verifyMigration(jsonlPath, dbPath);

      console.log(`  JSONL entries: ${result.jsonlCount}`);
      console.log(`  SQLite entries: ${result.dbCount}`);
      console.log(`  Match: ${result.match ? '✓ Yes' : '✗ No'}`);

      if (!result.match) {
        process.exit(1);
      }
    } catch (error) {
      console.error('Verify error:', (error as Error).message);
      process.exit(1);
    }
  });

// migrate rollback
migrateCommand
  .command('rollback')
  .description('Remove SQLite database (use backup JSONL to restore)')
  .option('-d, --dest <path>', 'SQLite database path to remove', 'memories.db')
  .option('--force', 'Skip confirmation prompt')
  .action(async (options: { dest: string; force: boolean }) => {
    try {
      resetConfig();
      const config = loadConfig();
      const workspace = config.agent.workspace;

      const dbPath = options.dest.startsWith('/')
        ? options.dest
        : `${workspace}/${options.dest}`;

      if (!options.force) {
        console.log(`WARNING: This will delete ${dbPath}`);
        console.log('Use --force to skip this confirmation');
        process.exit(1);
      }

      console.log(`Removing SQLite database: ${dbPath}`);
      await rollbackMigration(dbPath);
      console.log('✓ Rollback complete');
    } catch (error) {
      console.error('Rollback error:', (error as Error).message);
      process.exit(1);
    }
  });

program.parse();
