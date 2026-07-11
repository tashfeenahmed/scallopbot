import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScallopDatabase } from './db.js';

describe('proactive delivery receipts', () => {
  let dir: string | null = null;
  let db: ScallopDatabase | null = null;

  afterEach(() => {
    db?.close();
    db = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('persists every append-only chunk mapping across database reopen', () => {
    dir = mkdtempSync(join(tmpdir(), 'project-atlas-delivery-receipts-'));
    const dbPath = join(dir, 'memory.sqlite');
    db = new ScallopDatabase(dbPath);

    expect(db.recordProactiveDeliveryReceipt({
      channel: 'telegram',
      channelMessageIds: ['1101', '1102'],
      scheduledItemId: 'atlas-wrapper',
      ownerUserId: 'default',
    })).toBe(2);
    db.close();

    db = new ScallopDatabase(dbPath);
    expect(db.getProactiveDeliveryReceipts('telegram', '1101')).toEqual([
      expect.objectContaining({
        channel: 'telegram',
        channelMessageId: '1101',
        scheduledItemId: 'atlas-wrapper',
        ownerUserId: 'default',
        ambiguous: false,
      }),
    ]);
    expect(db.getProactiveDeliveryReceipts('telegram', '1102')).toEqual([
      expect.objectContaining({
        channelMessageId: '1102',
        scheduledItemId: 'atlas-wrapper',
      }),
    ]);

    // Retry is idempotent; append-only provenance is not rewritten.
    expect(db.recordProactiveDeliveryReceipt({
      channel: 'telegram',
      channelMessageIds: ['1101', '1102'],
      scheduledItemId: 'atlas-wrapper',
      ownerUserId: 'default',
    })).toBe(0);
  });
});
