#!/usr/bin/env node
/**
 * ScallopBot MCP server (stdio).
 *
 * Exposes ScallopBot's memory as three MCP tools -- `memory_store`,
 * `memory_recall`, `memory_temporal` -- so Claude Code, Codex, or any other MCP
 * client can read and write the same memory the bot uses.
 *
 *   SCALLOPBOT_DB   path to memories.db (falls back to MEMORY_DB_PATH, then
 *                   ./memories.db, matching the bot's own default)
 *   SCALLOPBOT_USER memory owner (default "default")
 *
 * RUNNING ALONGSIDE THE BOT
 * -------------------------
 * This is safe to run while the bot is live. The database is in WAL mode, so
 * readers never block the writer. Two things keep writes safe:
 *
 *   1. `PRAGMA busy_timeout` (see BUSY_TIMEOUT_MS) makes this process wait for
 *      the bot's write lock instead of failing instantly with SQLITE_BUSY.
 *   2. No write transaction is ever held across an `await`. Embedding
 *      generation and relation detection happen outside the write, so the
 *      actual INSERT is a single short statement. Wrapping the whole of
 *      `store.add()` in a transaction would be worse, not better: it would hold
 *      the write lock open across a network call and stall the bot.
 */

import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { createScallopMemoryStore } from '../memory/scallop-store.js';
import { LineDecoder, encodeMessage } from './protocol.js';
import { McpServer } from './server.js';

/**
 * How long to wait for the bot to release the write lock before giving up.
 * Comfortably longer than any single write the bot performs.
 */
const BUSY_TIMEOUT_MS = 5000;

function resolveDbPath(): string {
  return process.env.SCALLOPBOT_DB || process.env.MEMORY_DB_PATH || 'memories.db';
}

export async function main(): Promise<void> {
  const dbPath = resolveDbPath();

  // stdout is the JSON-RPC channel and must carry nothing else, so every log
  // line goes to stderr. A single stray stdout write corrupts the protocol.
  const logger = pino(
    { level: process.env.LOG_LEVEL || 'warn', name: 'scallopbot-mcp' },
    pino.destination(2)
  );

  const store = createScallopMemoryStore({ dbPath, logger });

  // Wait out the bot's write lock rather than failing on SQLITE_BUSY.
  store.getDatabase().raw(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

  const server = new McpServer({
    store,
    userId: process.env.SCALLOPBOT_USER || 'default',
    // No embedding provider is wired up in the standalone server: it must start
    // without API keys. Recall degrades to BM25 and says so in its output.
    hasEmbedder: false,
  });

  logger.info({ dbPath }, 'ScallopBot MCP server ready');

  const decoder = new LineDecoder();
  // Responses are serialized through a single chain so concurrent tool calls
  // can never interleave partial lines on stdout.
  let writeChain: Promise<void> = Promise.resolve();

  const write = (payload: string): void => {
    writeChain = writeChain.then(
      () =>
        new Promise<void>(resolve => {
          if (!process.stdout.write(payload)) {
            process.stdout.once('drain', () => resolve());
          } else {
            resolve();
          }
        })
    );
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    for (const message of decoder.push(String(chunk))) {
      void server
        .handle(message)
        .then(response => {
          if (response) write(encodeMessage(response));
        })
        .catch(error => {
          logger.error({ error: (error as Error).message }, 'Message handling failed');
        });
    }
  });

  const shutdown = (): void => {
    try {
      store.close();
    } catch {
      // Already closed, or the file went away. Nothing useful to do on exit.
    }
    process.exit(0);
  };

  process.stdin.on('end', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only run when invoked directly, so the module stays importable from tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: Error) => {
    process.stderr.write(`scallopbot-mcp failed to start: ${error.message}\n`);
    process.exit(1);
  });
}
