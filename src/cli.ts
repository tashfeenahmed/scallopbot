#!/usr/bin/env node

import { Command } from 'commander';
import * as readline from 'readline';
import { pino } from 'pino';
import { loadConfig, resetConfig } from './config/index.js';
import { Gateway, setupGracefulShutdown } from './gateway/index.js';
import { createLogger } from './utils/logger.js';
import { SkillPackageManager, SkillInstaller } from './skills/clawhub.js';
import { SkillLoader } from './skills/loader.js';

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
  .description('Search for skills in the registry')
  .action(async (query: string) => {
    try {
      const manager = new SkillPackageManager();
      const results = await manager.search(query);

      if (results.total === 0) {
        console.log(`No skills found matching "${query}"`);
        return;
      }

      console.log(`Found ${results.total} skill(s):\n`);
      for (const pkg of results.packages) {
        console.log(`  ${pkg.name} (v${pkg.version})`);
        console.log(`    ${pkg.description}`);
        if (pkg.homepage) {
          console.log(`    ${pkg.homepage}`);
        }
        console.log('');
      }
    } catch (error) {
      console.error('Search failed:', (error as Error).message);
      process.exit(1);
    }
  });

// skill install
skillCommand
  .command('install <name>')
  .description('Install a skill from the registry')
  .option('--url <url>', 'Install from a specific URL')
  .option('--deps', 'Also install skill dependencies')
  .action(async (name: string, options: { url?: string; deps?: boolean }) => {
    try {
      const manager = new SkillPackageManager();

      console.log(`Installing skill: ${name}...`);

      let result;
      if (options.url) {
        result = await manager.installFromUrl(name, options.url);
      } else {
        result = await manager.install(name);
      }

      if (result.success) {
        console.log(`\n✓ Installed ${result.skill?.name} to ${result.path}`);
        if (result.checksum) {
          console.log(`  Checksum: ${result.checksum.slice(0, 16)}...`);
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

// skill info
skillCommand
  .command('info <name>')
  .description('Show detailed information about a skill')
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

program.parse();
