/**
 * Migration Script: JSONL to SQLite
 *
 * Migrates existing memories from JSONL file to SQLite database
 * with proper mapping to the new schema.
 */

import * as fs from 'fs/promises';
import type { MemoryEntry, MemoryType } from './legacy-types.js';
import { ScallopDatabase, type MemoryCategory, type ScallopMemoryType } from './db.js';

/**
 * Migration options
 */
export interface MigrationOptions {
  /** Path to existing JSONL file */
  jsonlPath: string;
  /** Path for new SQLite database */
  dbPath: string;
  /** Create backup of JSONL file (default: true) */
  createBackup?: boolean;
  /** Default user ID for memories without one */
  defaultUserId?: string;
  /** Whether to keep original JSONL file (default: true) */
  keepOriginal?: boolean;
}

/**
 * Migration result
 */
export interface MigrationResult {
  success: boolean;
  memoriesImported: number;
  memoriesSkipped: number;
  errors: string[];
  backupPath?: string;
  dbPath: string;
}

/**
 * Map old MemoryType to new schema types
 */
function mapMemoryType(oldType: MemoryType): { category: MemoryCategory; memoryType: ScallopMemoryType } {
  switch (oldType) {
    case 'fact':
      return { category: 'fact', memoryType: 'regular' };
    case 'preference':
      return { category: 'preference', memoryType: 'regular' };
    case 'summary':
      return { category: 'insight', memoryType: 'derived' };
    case 'context':
      return { category: 'event', memoryType: 'regular' };
    case 'raw':
    default:
      return { category: 'fact', memoryType: 'regular' };
  }
}

/**
 * Extract category from content if possible
 */
function inferCategory(content: string, metadata?: Record<string, unknown>): MemoryCategory {
  // Check metadata first
  if (metadata?.category) {
    const cat = (metadata.category as string).toLowerCase();
    if (['preference', 'fact', 'event', 'relationship', 'insight'].includes(cat)) {
      return cat as MemoryCategory;
    }
  }

  // Infer from content
  const lower = content.toLowerCase();

  if (lower.startsWith('preference:') || lower.includes('prefer') || lower.includes('like')) {
    return 'preference';
  }
  if (lower.startsWith('relationship:') || lower.includes('friend') || lower.includes('family')) {
    return 'relationship';
  }
  if (lower.startsWith('location:') || lower.startsWith('office:')) {
    return 'fact';
  }
  if (lower.includes('event') || lower.includes('meeting') || lower.includes('schedule')) {
    return 'event';
  }

  return 'fact';
}

/**
 * Migrate from JSONL to SQLite
 */
export async function migrateJsonlToSqlite(options: MigrationOptions): Promise<MigrationResult> {
  const result: MigrationResult = {
    success: false,
    memoriesImported: 0,
    memoriesSkipped: 0,
    errors: [],
    dbPath: options.dbPath,
  };

  const { jsonlPath, dbPath, createBackup = true, defaultUserId = 'default', keepOriginal: _keepOriginal = true } = options;

  try {
    // Check if JSONL file exists
    try {
      await fs.access(jsonlPath);
    } catch {
      result.errors.push(`JSONL file not found: ${jsonlPath}`);
      return result;
    }

    // Create backup if requested
    if (createBackup) {
      const backupPath = jsonlPath + '.backup.' + Date.now();
      await fs.copyFile(jsonlPath, backupPath);
      result.backupPath = backupPath;
    }

    // Read JSONL file
    const content = await fs.readFile(jsonlPath, 'utf-8');
    const lines = content.trim().split('\n').filter((line) => line.trim());

    // Create SQLite database
    const db = new ScallopDatabase(dbPath);

    // Process each line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      try {
        const oldEntry = JSON.parse(line) as MemoryEntry;

        // Map old entry to new schema
        const { category, memoryType } = mapMemoryType(oldEntry.type);
        const inferredCategory = inferCategory(oldEntry.content, oldEntry.metadata as Record<string, unknown> | undefined);

        // Determine user ID
        const userId = (oldEntry.metadata?.userId as string) ||
          (oldEntry.metadata?.subject === 'user' ? defaultUserId : (oldEntry.metadata?.subject as string)) ||
          oldEntry.sessionId ||
          defaultUserId;

        // Calculate initial prominence based on type and recency
        const ageMs = Date.now() - new Date(oldEntry.timestamp).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const baseProminence = memoryType === 'derived' ? 0.98 : 0.97;
        const prominence = Math.max(0.1, Math.pow(baseProminence, ageDays));

        // Check if superseded
        const isSuperseded = !!(oldEntry.metadata?.superseded);

        db.addMemory({
          userId,
          content: oldEntry.content,
          category: inferredCategory || category,
          memoryType: isSuperseded ? 'superseded' : memoryType,
          importance: 5,
          confidence: 0.8,
          isLatest: !isSuperseded,
          documentDate: new Date(oldEntry.timestamp).getTime(),
          eventDate: null, // Will be extracted by temporal grounding phase
          prominence: isSuperseded ? prominence * 0.5 : prominence,
          lastAccessed: null,
          accessCount: 0,
          sourceChunk: null,
          embedding: oldEntry.embedding || null,
          metadata: {
            ...(oldEntry.metadata || {}),
            migratedFrom: 'jsonl',
            originalId: oldEntry.id,
            originalType: oldEntry.type,
            originalSessionId: oldEntry.sessionId,
            subject: oldEntry.metadata?.subject || 'user',
            tags: oldEntry.tags,
          },
        });

        result.memoriesImported++;
      } catch (err) {
        result.errors.push(`Line ${i + 1}: ${(err as Error).message}`);
        result.memoriesSkipped++;
      }
    }

    // If migration successful and not keeping original, we could delete it
    // But for safety, we always keep it during initial migration

    db.close();
    result.success = true;

    return result;
  } catch (err) {
    result.errors.push(`Migration failed: ${(err as Error).message}`);
    return result;
  }
}

/**
 * Verify migration by comparing counts
 */
export async function verifyMigration(
  jsonlPath: string,
  dbPath: string
): Promise<{ jsonlCount: number; dbCount: number; match: boolean }> {
  // Count JSONL entries
  const content = await fs.readFile(jsonlPath, 'utf-8');
  const jsonlCount = content.trim().split('\n').filter((line) => line.trim()).length;

  // Count SQLite entries
  const db = new ScallopDatabase(dbPath);
  const dbCount = db.getMemoryCount();
  db.close();

  return {
    jsonlCount,
    dbCount,
    match: jsonlCount === dbCount,
  };
}

/**
 * Rollback migration by deleting the SQLite database
 */
export async function rollbackMigration(dbPath: string): Promise<void> {
  try {
    await fs.unlink(dbPath);
    // Also remove WAL and SHM files if they exist
    await fs.unlink(dbPath + '-wal').catch(() => {});
    await fs.unlink(dbPath + '-shm').catch(() => {});
  } catch (err) {
    throw new Error(`Rollback failed: ${(err as Error).message}`);
  }
}

/**
 * CLI entry point for running migration
 */
export async function runMigrationCLI(args: string[]): Promise<void> {
  const jsonlPath = args[0] || './memories.jsonl';
  const dbPath = args[1] || './memories.db';

  console.log('ScallopMemory Migration: JSONL -> SQLite');
  console.log('========================================');
  console.log(`Source: ${jsonlPath}`);
  console.log(`Target: ${dbPath}`);
  console.log('');

  const result = await migrateJsonlToSqlite({
    jsonlPath,
    dbPath,
    createBackup: true,
  });

  if (result.success) {
    console.log(`Migration successful!`);
    console.log(`  Imported: ${result.memoriesImported}`);
    console.log(`  Skipped: ${result.memoriesSkipped}`);
    if (result.backupPath) {
      console.log(`  Backup: ${result.backupPath}`);
    }
  } else {
    console.error('Migration failed!');
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
  }
}
