import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ScallopDatabase } from './db.js';

describe('durable user identity', () => {
  let dbPath = '';
  let db: ScallopDatabase | null = null;

  afterEach(() => {
    db?.close();
    db = null;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* already removed */ }
    }
  });

  it('preserves separate memories, profiles, summaries, and scheduled items after reopen', () => {
    dbPath = path.join(
      os.tmpdir(),
      `state-owner-reopen-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = new ScallopDatabase(dbPath);

    const users = ['default', 'telegram:user-alpha', 'telegram:user-beta'] as const;
    const labels = ['Canonical Example', 'Alpha Example', 'Beta Example'] as const;
    const memoryIds: string[] = [];
    const scheduledIds: string[] = [];

    users.forEach((userId, index) => {
      db!.createSession(`session-${index}`, { userId, channelId: 'telegram' });
      memoryIds.push(db!.addMemory({
        userId,
        content: `${labels[index]} stores a synthetic private fact ${index}.`,
        category: 'fact',
        memoryType: 'regular',
        importance: 8,
        confidence: 1,
        isLatest: true,
        source: 'user',
        documentDate: Date.now(),
        eventDate: null,
        prominence: 0.8,
        lastAccessed: null,
        accessCount: 0,
        sourceChunk: null,
        embedding: [index + 0.1, index + 0.2],
        metadata: { subject: 'user' },
      }).id);
      db!.setProfileValue(userId, 'name', labels[index], 1);
      db!.addSessionSummary({
        sessionId: `session-${index}`,
        userId,
        summary: `${labels[index]} synthetic session summary.`,
        topics: [`topic-${index}`],
        messageCount: index + 1,
        durationMs: 1_000,
        embedding: null,
      });
      scheduledIds.push(db!.addScheduledItem({
        userId,
        sessionId: `session-${index}`,
        source: 'user',
        kind: 'nudge',
        type: 'reminder',
        message: `${labels[index]} synthetic reminder.`,
        messageProvenance: 'user_literal',
        context: null,
        triggerAt: Date.now() + 60_000 + index,
        recurring: null,
        sourceMemoryId: null,
      }).id);
    });

    db.close();
    db = new ScallopDatabase(dbPath);

    users.forEach((userId, index) => {
      expect(db!.getMemory(memoryIds[index])).toMatchObject({
        userId,
        content: `${labels[index]} stores a synthetic private fact ${index}.`,
      });
      expect(db!.getMemoriesByUser(userId, { includeAllSources: true })
        .some(memory => memory.id === memoryIds[index])).toBe(true);
      expect(db!.getProfileValue(userId, 'name')).toMatchObject({
        userId,
        value: labels[index],
      });
      expect(db!.getSessionSummariesByUser(userId).map(summary => summary.sessionId))
        .toContain(`session-${index}`);
      expect(db!.getScheduledItemsByUser(userId).map(item => item.id))
        .toContain(scheduledIds[index]);
    });
  });
});
