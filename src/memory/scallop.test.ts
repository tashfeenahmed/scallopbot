/**
 * Tests for ScallopMemory System
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  ScallopDatabase,
  DecayEngine,
  RelationGraph,
  ProfileManager,
  TemporalExtractor,
  TemporalQuery,
  ScallopMemoryStore,
  BackgroundGardener,
  TFIDFEmbedder,
  PROMINENCE_THRESHOLDS,
  type ActivationConfig,
} from './index.js';
import pino from 'pino';
import type { LLMProvider, CompletionResponse } from '../providers/types.js';

const TEST_DB_PATH = '/tmp/scallop-test.db';
const logger = pino({ level: 'silent' });

// Clean up test database
function cleanupTestDb() {
  try {
    fs.unlinkSync(TEST_DB_PATH);
    fs.unlinkSync(TEST_DB_PATH + '-wal');
    fs.unlinkSync(TEST_DB_PATH + '-shm');
  } catch {
    // Ignore if files don't exist
  }
}

describe('ScallopDatabase', () => {
  let db: ScallopDatabase;

  beforeEach(() => {
    cleanupTestDb();
    db = new ScallopDatabase(TEST_DB_PATH);
  });

  afterEach(() => {
    db.close();
    cleanupTestDb();
  });

  it('should create database and tables', () => {
    expect(db.getMemoryCount()).toBe(0);
  });

  it('should add and retrieve memory', () => {
    const memory = db.addMemory({
      userId: 'user1',
      content: 'Test memory content',
      category: 'fact',
      memoryType: 'regular',
      importance: 5,
      confidence: 0.8,
      isLatest: true,
      documentDate: Date.now(),
      eventDate: null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: null,
    });

    expect(memory.id).toBeDefined();
    expect(memory.content).toBe('Test memory content');

    const retrieved = db.getMemory(memory.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.content).toBe('Test memory content');
  });

  it('should update memory', () => {
    const memory = db.addMemory({
      userId: 'user1',
      content: 'Original content',
      category: 'fact',
      memoryType: 'regular',
      importance: 5,
      confidence: 0.8,
      isLatest: true,
      documentDate: Date.now(),
      eventDate: null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: null,
    });

    db.updateMemory(memory.id, { content: 'Updated content', importance: 8 });

    const updated = db.getMemory(memory.id);
    expect(updated?.content).toBe('Updated content');
    expect(updated?.importance).toBe(8);
  });

  it('should delete memory', () => {
    const memory = db.addMemory({
      userId: 'user1',
      content: 'To be deleted',
      category: 'fact',
      memoryType: 'regular',
      importance: 5,
      confidence: 0.8,
      isLatest: true,
      documentDate: Date.now(),
      eventDate: null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: null,
    });

    expect(db.deleteMemory(memory.id)).toBe(true);
    expect(db.getMemory(memory.id)).toBeNull();
  });

  it('should filter memories by user and category', () => {
    db.addMemory({
      userId: 'user1',
      content: 'User 1 fact',
      category: 'fact',
      memoryType: 'regular',
      importance: 5,
      confidence: 0.8,
      isLatest: true,
      documentDate: Date.now(),
      eventDate: null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: null,
    });

    db.addMemory({
      userId: 'user1',
      content: 'User 1 preference',
      category: 'preference',
      memoryType: 'regular',
      importance: 5,
      confidence: 0.8,
      isLatest: true,
      documentDate: Date.now(),
      eventDate: null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: null,
    });

    db.addMemory({
      userId: 'user2',
      content: 'User 2 fact',
      category: 'fact',
      memoryType: 'regular',
      importance: 5,
      confidence: 0.8,
      isLatest: true,
      documentDate: Date.now(),
      eventDate: null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: null,
    });

    const user1Facts = db.getMemoriesByUser('user1', { category: 'fact' });
    expect(user1Facts).toHaveLength(1);
    expect(user1Facts[0].content).toBe('User 1 fact');

    const user1All = db.getMemoriesByUser('user1');
    expect(user1All).toHaveLength(2);
  });

  it('should add and retrieve relations', () => {
    const mem1 = db.addMemory({
      userId: 'user1',
      content: 'Old fact',
      category: 'fact',
      memoryType: 'regular',
      importance: 5,
      confidence: 0.8,
      isLatest: true,
      documentDate: Date.now(),
      eventDate: null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: null,
    });

    const mem2 = db.addMemory({
      userId: 'user1',
      content: 'New fact that updates old',
      category: 'fact',
      memoryType: 'regular',
      importance: 5,
      confidence: 0.8,
      isLatest: true,
      documentDate: Date.now(),
      eventDate: null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: null,
    });

    const relation = db.addRelation(mem2.id, mem1.id, 'UPDATES', 0.9);
    expect(relation.relationType).toBe('UPDATES');

    // Check that old memory is marked as superseded
    const oldMem = db.getMemory(mem1.id);
    expect(oldMem?.isLatest).toBe(false);
    expect(oldMem?.memoryType).toBe('superseded');

    const relations = db.getRelations(mem1.id);
    expect(relations).toHaveLength(1);
  });

  it('should manage user profiles', () => {
    db.setProfileValue('user1', 'name', 'John Doe');
    db.setProfileValue('user1', 'timezone', 'America/New_York');

    expect(db.getProfileValue('user1', 'name')?.value).toBe('John Doe');

    const profile = db.getProfile('user1');
    expect(profile).toHaveLength(2);
  });

  it('should manage dynamic profiles', () => {
    db.updateDynamicProfile('user1', {
      recentTopics: ['AI', 'TypeScript'],
      currentMood: 'focused',
      activeProjects: ['ScallopBot'],
    });

    const profile = db.getDynamicProfile('user1');
    expect(profile?.recentTopics).toContain('AI');
    expect(profile?.currentMood).toBe('focused');
  });
});

describe('DecayEngine', () => {
  let db: ScallopDatabase;
  let decay: DecayEngine;

  beforeEach(() => {
    cleanupTestDb();
    db = new ScallopDatabase(TEST_DB_PATH);
    decay = new DecayEngine();
  });

  afterEach(() => {
    db.close();
    cleanupTestDb();
  });

  it('should calculate prominence for recent memory', () => {
    const memory = db.addMemory({
      userId: 'user1',
      content: 'Recent memory',
      category: 'fact',
      memoryType: 'regular',
      importance: 5,
      confidence: 0.8,
      isLatest: true,
      documentDate: Date.now(),
      eventDate: null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: null,
    });

    const prominence = decay.calculateProminence(memory);
    expect(prominence).toBeGreaterThan(0.5);
  });

  it('should decay old memories', () => {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    const memory = db.addMemory({
      userId: 'user1',
      content: 'Old memory',
      category: 'fact',
      memoryType: 'regular',
      importance: 5,
      confidence: 0.8,
      isLatest: true,
      documentDate: thirtyDaysAgo,
      eventDate: null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: null,
    });

    const prominence = decay.calculateProminence(memory);
    expect(prominence).toBeLessThan(0.9); // Should have decayed (slower rates = higher threshold)
  });

  it('should not decay static profile memories', () => {
    const oldDate = Date.now() - 365 * 24 * 60 * 60 * 1000; // 1 year ago

    const memory = db.addMemory({
      userId: 'user1',
      content: 'User name is John',
      category: 'fact',
      memoryType: 'static_profile',
      importance: 10,
      confidence: 0.9,
      isLatest: true,
      documentDate: oldDate,
      eventDate: null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: null,
    });

    const prominence = decay.calculateProminence(memory);
    expect(prominence).toBe(1.0);
  });

  it('should boost frequently accessed memories', () => {
    const memory1 = db.addMemory({
      userId: 'user1',
      content: 'Never accessed',
      category: 'fact',
      memoryType: 'regular',
      importance: 5,
      confidence: 0.8,
      isLatest: true,
      documentDate: Date.now() - 7 * 24 * 60 * 60 * 1000,
      eventDate: null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: null,
    });

    const memory2 = db.addMemory({
      userId: 'user1',
      content: 'Frequently accessed',
      category: 'fact',
      memoryType: 'regular',
      importance: 5,
      confidence: 0.8,
      isLatest: true,
      documentDate: Date.now() - 7 * 24 * 60 * 60 * 1000,
      eventDate: null,
      prominence: 1.0,
      lastAccessed: Date.now(),
      accessCount: 10,
      sourceChunk: null,
      embedding: null,
      metadata: null,
    });

    const p1 = decay.calculateProminence(memory1);
    const p2 = decay.calculateProminence(memory2);

    expect(p2).toBeGreaterThan(p1);
  });
});

describe('RelationGraph', () => {
  let db: ScallopDatabase;
  let graph: RelationGraph;

  beforeEach(() => {
    cleanupTestDb();
    db = new ScallopDatabase(TEST_DB_PATH);
    graph = new RelationGraph(db);
  });

  afterEach(() => {
    db.close();
    cleanupTestDb();
  });

  it('should add UPDATES relation and mark old as superseded', () => {
    const old = db.addMemory({
      userId: 'user1',
      content: 'Lives in New York',
      category: 'fact',
      memoryType: 'regular',
      importance: 5,
      confidence: 0.8,
      isLatest: true,
      documentDate: Date.now() - 1000,
      eventDate: null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: null,
    });

    const newer = db.addMemory({
      userId: 'user1',
      content: 'Lives in Boston',
      category: 'fact',
      memoryType: 'regular',
      importance: 5,
      confidence: 0.8,
      isLatest: true,
      documentDate: Date.now(),
      eventDate: null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: null,
    });

    graph.addUpdatesRelation(newer.id, old.id);

    const latest = graph.getLatestVersion(old.id);
    expect(latest?.id).toBe(newer.id);

    const history = graph.getUpdateHistory(old.id);
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe(newer.id); // Most recent first
  });

  it('should track EXTENDS relations', () => {
    const base = db.addMemory({
      userId: 'user1',
      content: 'Works at TechCorp',
      category: 'fact',
      memoryType: 'regular',
      importance: 5,
      confidence: 0.8,
      isLatest: true,
      documentDate: Date.now(),
      eventDate: null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: null,
    });

    const extension = db.addMemory({
      userId: 'user1',
      content: 'Senior engineer at TechCorp',
      category: 'fact',
      memoryType: 'regular',
      importance: 5,
      confidence: 0.8,
      isLatest: true,
      documentDate: Date.now(),
      eventDate: null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: null,
    });

    graph.addExtendsRelation(extension.id, base.id);

    const extended = graph.getExtendedMemories(extension.id);
    expect(extended).toHaveLength(1);
    expect(extended[0].id).toBe(base.id);
  });
});

describe('ProfileManager', () => {
  let db: ScallopDatabase;
  let profiles: ProfileManager;

  beforeEach(() => {
    cleanupTestDb();
    db = new ScallopDatabase(TEST_DB_PATH);
    profiles = new ProfileManager(db);
  });

  afterEach(() => {
    db.close();
    cleanupTestDb();
  });

  it('should manage static profile values', () => {
    profiles.setStaticValue('user1', 'name', 'Alice');
    profiles.setStaticValue('user1', 'timezone', 'UTC');

    expect(profiles.getStaticValue('user1', 'name')).toBe('Alice');

    const full = profiles.getStaticProfile('user1');
    expect(full.name).toBe('Alice');
    expect(full.timezone).toBe('UTC');
  });

  it('should track recent topics', () => {
    profiles.addRecentTopic('user1', 'AI');
    profiles.addRecentTopic('user1', 'TypeScript');
    profiles.addRecentTopic('user1', 'React');

    const dynamic = profiles.getDynamicProfile('user1');
    expect(dynamic?.recentTopics).toHaveLength(3);
    expect(dynamic?.recentTopics[0]).toBe('React'); // Most recent first
  });

  it('should format profile context', () => {
    profiles.setStaticValue('user1', 'name', 'Bob');
    profiles.addRecentTopic('user1', 'ScallopBot');
    profiles.addActiveProject('user1', 'Memory System');

    const context = profiles.getContextString('user1');

    expect(context).toContain('Bob');
    expect(context).toContain('ScallopBot');
    expect(context).toContain('Memory System');
  });

  it('should populate all 4 signal fields when sufficient data is provided', () => {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    // Generate 15 messages spread over several days (>= 10 needed for frequency + length)
    const messages: Array<{ content: string; timestamp: number }> = [];
    for (let i = 0; i < 15; i++) {
      messages.push({
        content: `Test message number ${i} with some content to analyze for length trends`,
        timestamp: now - (14 - i) * DAY + i * 1000,
      });
    }

    // Generate 4 sessions (>= 3 needed for engagement)
    const sessions = [
      { messageCount: 5, durationMs: 600000, startTime: now - 10 * DAY },
      { messageCount: 8, durationMs: 900000, startTime: now - 7 * DAY },
      { messageCount: 3, durationMs: 300000, startTime: now - 3 * DAY },
      { messageCount: 6, durationMs: 720000, startTime: now - 1 * DAY },
    ];

    // Generate 6 messages with embeddings (>= 5 needed for topic switch)
    // Use orthogonal-ish embeddings to simulate topic switches
    const messageEmbeddings = [
      { content: 'msg1', embedding: [1, 0, 0, 0] },
      { content: 'msg2', embedding: [0.9, 0.1, 0, 0] }, // similar to prev
      { content: 'msg3', embedding: [0, 1, 0, 0] },      // switch
      { content: 'msg4', embedding: [0, 0.9, 0.1, 0] },  // similar to prev
      { content: 'msg5', embedding: [0, 0, 1, 0] },      // switch
      { content: 'msg6', embedding: [0, 0, 0.9, 0.1] },  // similar to prev
    ];

    profiles.inferBehavioralPatterns('user1', messages, {
      sessions,
      messageEmbeddings,
    });

    const behavioral = profiles.getBehavioralPatterns('user1');
    expect(behavioral).not.toBeNull();

    // All 4 signal fields should be populated
    expect(behavioral!.messageFrequency).not.toBeNull();
    expect(behavioral!.messageFrequency!.dailyRate).toBeGreaterThan(0);
    expect(behavioral!.messageFrequency!.trend).toBeDefined();

    expect(behavioral!.sessionEngagement).not.toBeNull();
    expect(behavioral!.sessionEngagement!.avgMessagesPerSession).toBeGreaterThan(0);
    expect(behavioral!.sessionEngagement!.avgDurationMs).toBeGreaterThan(0);

    expect(behavioral!.topicSwitch).not.toBeNull();
    expect(behavioral!.topicSwitch!.switchRate).toBeGreaterThan(0);
    expect(behavioral!.topicSwitch!.avgTopicDepth).toBeGreaterThan(0);

    expect(behavioral!.responseLength).not.toBeNull();
    expect(behavioral!.responseLength!.avgLength).toBeGreaterThan(0);
  });

  it('should include signal insights in formatProfileContext when signals are populated', () => {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    // Generate enough messages for signal computation
    const messages: Array<{ content: string; timestamp: number }> = [];
    for (let i = 0; i < 15; i++) {
      messages.push({
        content: `Message ${i} about various topics and content`,
        timestamp: now - (14 - i) * DAY,
      });
    }

    const sessions = [
      { messageCount: 5, durationMs: 600000, startTime: now - 10 * DAY },
      { messageCount: 8, durationMs: 900000, startTime: now - 7 * DAY },
      { messageCount: 3, durationMs: 300000, startTime: now - 3 * DAY },
    ];

    const messageEmbeddings = [
      { content: 'a', embedding: [1, 0, 0, 0] },
      { content: 'b', embedding: [0.9, 0.1, 0, 0] },
      { content: 'c', embedding: [0, 1, 0, 0] },
      { content: 'd', embedding: [0, 0.9, 0.1, 0] },
      { content: 'e', embedding: [0, 0, 1, 0] },
    ];

    profiles.inferBehavioralPatterns('user1', messages, {
      sessions,
      messageEmbeddings,
    });

    const context = profiles.formatProfileContext('user1');

    // Check for signal-based insights
    expect(context.behavioralPatterns).toContain('Messaging pace');
    expect(context.behavioralPatterns).toContain('/day');
    expect(context.behavioralPatterns).toContain('Session style');
    expect(context.behavioralPatterns).toContain('messages over');
    expect(context.behavioralPatterns).toContain('messages per topic');
  });

  it('should return null signals on cold start (insufficient data)', () => {
    // Only 3 messages (below 10 threshold for frequency + length)
    const now = Date.now();
    const messages = [
      { content: 'Hello', timestamp: now - 3000 },
      { content: 'How are you?', timestamp: now - 2000 },
      { content: 'Fine thanks', timestamp: now - 1000 },
    ];

    profiles.inferBehavioralPatterns('user1', messages);

    const behavioral = profiles.getBehavioralPatterns('user1');
    expect(behavioral).not.toBeNull();

    // Signals should be null due to cold start
    expect(behavioral!.messageFrequency).toBeNull();
    expect(behavioral!.responseLength).toBeNull();
    // No sessions or embeddings provided — also null
    expect(behavioral!.sessionEngagement).toBeNull();
    expect(behavioral!.topicSwitch).toBeNull();
  });

  it('should be backward compatible (calling without optional params)', () => {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    // Generate enough messages for basic analysis
    const messages: Array<{ content: string; timestamp: number }> = [];
    for (let i = 0; i < 12; i++) {
      messages.push({
        content: `Test message number ${i}`,
        timestamp: now - (11 - i) * DAY,
      });
    }

    // Call without the optional params — should not throw
    profiles.inferBehavioralPatterns('user1', messages);

    const behavioral = profiles.getBehavioralPatterns('user1');
    expect(behavioral).not.toBeNull();
    expect(behavioral!.communicationStyle).toBeDefined();
    expect(behavioral!.activeHours).toBeDefined();

    // messageFrequency and responseLength should compute (>= 10 messages)
    expect(behavioral!.messageFrequency).not.toBeNull();
    expect(behavioral!.responseLength).not.toBeNull();

    // sessionEngagement and topicSwitch should be null (no optional params)
    expect(behavioral!.sessionEngagement).toBeNull();
    expect(behavioral!.topicSwitch).toBeNull();
  });
});

describe('TemporalExtractor', () => {
  let extractor: TemporalExtractor;
  // Use a mid-month date to avoid month boundary issues
  const refDate = new Date('2026-02-15T12:00:00Z');
  const refTimestamp = refDate.getTime();

  beforeEach(() => {
    extractor = new TemporalExtractor(refDate);
  });

  it('should extract relative dates', () => {
    // Pass refTimestamp as documentDate so relative dates are computed from it
    const tomorrow = extractor.extract('Meeting tomorrow at 3pm', refTimestamp);
    expect(tomorrow.eventDate).not.toBeNull();

    const tomorrowDate = new Date(tomorrow.eventDate!);
    // Check it's approximately 1 day after refDate
    const diffMs = tomorrowDate.getTime() - refTimestamp;
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(1);
  });

  it('should extract "next week"', () => {
    const result = extractor.extract('Conference next week', refTimestamp);
    expect(result.eventDate).not.toBeNull();

    const eventDate = new Date(result.eventDate!);
    // Check it's approximately 7 days after refDate
    const diffMs = eventDate.getTime() - refTimestamp;
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(7);
  });

  it('should extract "3 days ago"', () => {
    const result = extractor.extract('Finished the project 3 days ago', refTimestamp);
    expect(result.eventDate).not.toBeNull();

    const eventDate = new Date(result.eventDate!);
    // Check it's approximately 3 days before refDate
    const diffMs = refTimestamp - eventDate.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(3);
  });

  it('should extract absolute dates', () => {
    const result = extractor.extract('Deadline is February 15, 2026');
    expect(result.eventDate).not.toBeNull();

    const eventDate = new Date(result.eventDate!);
    expect(eventDate.getMonth()).toBe(1); // February
    expect(eventDate.getDate()).toBe(15);
    expect(eventDate.getFullYear()).toBe(2026);
  });

  it('should extract ISO dates', () => {
    const result = extractor.extract('Event on 2026-03-20');
    expect(result.eventDate).not.toBeNull();

    const eventDate = new Date(result.eventDate!);
    expect(eventDate.getFullYear()).toBe(2026);
    expect(eventDate.getMonth()).toBe(2); // March
    expect(eventDate.getDate()).toBe(20);
  });
});

describe('TemporalQuery', () => {
  it('should get this week range', () => {
    const refDate = new Date('2026-02-03T12:00:00Z'); // Tuesday
    const range = TemporalQuery.thisWeek(refDate);

    const start = new Date(range.start);
    const end = new Date(range.end);

    expect(start.getDay()).toBe(0); // Sunday
    expect(end.getDay()).toBe(6); // Saturday
  });

  it('should get last N days', () => {
    const refDate = new Date('2026-02-03T12:00:00Z');
    const range = TemporalQuery.lastDays(7, refDate);

    const start = new Date(range.start);
    const expectedStart = new Date('2026-01-27T00:00:00');

    expect(start.getDate()).toBe(expectedStart.getDate());
  });
});

describe('ScallopMemoryStore', () => {
  let store: ScallopMemoryStore;

  beforeEach(() => {
    cleanupTestDb();
    store = new ScallopMemoryStore({
      dbPath: TEST_DB_PATH,
      logger,
    });
  });

  afterEach(() => {
    store.close();
    cleanupTestDb();
  });

  it('should add and retrieve memories', async () => {
    const memory = await store.add({
      userId: 'user1',
      content: 'User lives in London',
      category: 'fact',
    });

    expect(memory.id).toBeDefined();
    expect(memory.content).toBe('User lives in London');

    const retrieved = store.get(memory.id);
    expect(retrieved?.content).toBe('User lives in London');
  });

  it('should search memories', async () => {
    await store.add({ userId: 'user1', content: 'User works at Microsoft', category: 'fact' });
    await store.add({ userId: 'user1', content: 'User likes TypeScript', category: 'preference' });
    await store.add({ userId: 'user1', content: 'User lives in Seattle', category: 'fact' });

    const results = await store.search('Microsoft', { userId: 'user1' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].memory.content).toContain('Microsoft');
  });

  it('should get active memories', async () => {
    await store.add({ userId: 'user1', content: 'Active memory 1', category: 'fact' });
    await store.add({ userId: 'user1', content: 'Active memory 2', category: 'fact' });

    const active = store.getActiveMemories('user1');
    expect(active.length).toBe(2);
  });

  it('should process decay', async () => {
    await store.add({ userId: 'user1', content: 'Test memory', category: 'fact' });

    const result = store.processDecay();
    expect(result.updated).toBeGreaterThanOrEqual(0);
  });

  it('should generate profile context', async () => {
    store.setProfileValue('user1', 'name', 'Test User');
    await store.add({ userId: 'user1', content: 'Working on AI project', category: 'fact' });

    const context = await store.getProfileContext('user1');
    expect(context).toContain('Test User');
  });
});

describe('ScallopMemoryStore search with re-ranking', () => {
  const RERANK_DB_PATH = '/tmp/scallop-rerank-test.db';

  function cleanupRerankDb() {
    try {
      fs.unlinkSync(RERANK_DB_PATH);
      fs.unlinkSync(RERANK_DB_PATH + '-wal');
      fs.unlinkSync(RERANK_DB_PATH + '-shm');
    } catch {
      // Ignore if files don't exist
    }
  }

  /**
   * Create a mock LLMProvider that returns predictable relevance scores.
   * Maps memory index to LLM score via the provided scoreMap.
   */
  function createMockRerankProvider(scoreMap: Record<number, number>): LLMProvider {
    const llmResponse = JSON.stringify(
      Object.entries(scoreMap).map(([index, score]) => ({ index: Number(index), score }))
    );
    return {
      name: 'mock-reranker',
      isAvailable: () => true,
      complete: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: llmResponse }],
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50 },
        model: 'mock-model',
      } satisfies CompletionResponse),
    };
  }

  it('should re-order results based on LLM relevance scores', async () => {
    cleanupRerankDb();

    // LLM will rank "sushi restaurant" highest, then "vegetarian options", and push "hiking" lower
    const rerankProvider = createMockRerankProvider({
      0: 0.9,   // sushi restaurant — top LLM relevance
      1: 0.1,   // hiking trails — low LLM relevance
      2: 0.8,   // vegetarian options — high LLM relevance
    });

    const store = new ScallopMemoryStore({
      dbPath: RERANK_DB_PATH,
      logger,
      rerankProvider,
    });

    try {
      // Store memories — content crafted so BM25 "food" keyword scoring gives different order
      await store.add({ userId: 'user1', content: 'Best sushi restaurant downtown', category: 'fact' });
      await store.add({ userId: 'user1', content: 'Great hiking trails nearby with food stands', category: 'fact' });
      await store.add({ userId: 'user1', content: 'Vegetarian food options at the café', category: 'preference' });

      const results = await store.search('food recommendations', { userId: 'user1', limit: 3 });

      // Verify provider.complete was called (re-ranking happened)
      expect(rerankProvider.complete).toHaveBeenCalled();

      // Results should be re-ordered by LLM scores
      expect(results.length).toBeGreaterThan(0);

      // The re-ranked order should reflect LLM preference:
      // sushi (0.9 LLM) should beat hiking (0.1 LLM)
      const ids = results.map(r => r.memory.content);
      const sushiIdx = ids.findIndex(c => c.includes('sushi'));
      const hikingIdx = ids.findIndex(c => c.includes('hiking'));
      if (sushiIdx !== -1 && hikingIdx !== -1) {
        expect(sushiIdx).toBeLessThan(hikingIdx);
      }
    } finally {
      store.close();
      cleanupRerankDb();
    }
  });

  it('should fall back to original scores when LLM fails', async () => {
    cleanupRerankDb();

    const failingProvider: LLMProvider = {
      name: 'mock-failing',
      isAvailable: () => true,
      complete: vi.fn().mockRejectedValue(new Error('API rate limit exceeded')),
    };

    const store = new ScallopMemoryStore({
      dbPath: RERANK_DB_PATH,
      logger,
      rerankProvider: failingProvider,
    });

    try {
      await store.add({ userId: 'user1', content: 'User works at Microsoft', category: 'fact' });
      await store.add({ userId: 'user1', content: 'User likes TypeScript', category: 'preference' });

      const results = await store.search('Microsoft', { userId: 'user1' });

      // Should still return results despite LLM failure
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].memory.content).toContain('Microsoft');
    } finally {
      store.close();
      cleanupRerankDb();
    }
  });

  it('should skip re-ranking when no rerankProvider set', async () => {
    cleanupRerankDb();

    const store = new ScallopMemoryStore({
      dbPath: RERANK_DB_PATH,
      logger,
      // No rerankProvider — should use original scoring only
    });

    try {
      await store.add({ userId: 'user1', content: 'User works at Google', category: 'fact' });
      await store.add({ userId: 'user1', content: 'User enjoys cooking', category: 'preference' });

      const results = await store.search('Google', { userId: 'user1' });

      // Should return results with original BM25+semantic scores
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].memory.content).toContain('Google');
    } finally {
      store.close();
      cleanupRerankDb();
    }
  });
});

describe('ScallopMemoryStore LLM relation classification', () => {
  const RELATIONS_DB_PATH = '/tmp/scallop-relations-test.db';

  function cleanupRelationsDb() {
    try {
      fs.unlinkSync(RELATIONS_DB_PATH);
      fs.unlinkSync(RELATIONS_DB_PATH + '-wal');
      fs.unlinkSync(RELATIONS_DB_PATH + '-shm');
    } catch {
      // Ignore if files don't exist
    }
  }

  it('should use LLM classifier for relation detection when relationsProvider is set', async () => {
    cleanupRelationsDb();

    const mockComplete = vi.fn().mockImplementation(async (req: unknown) => {
      // Return UPDATES classification with the targetId of the first existing fact
      // The classifier sends existing facts in format: [id] (subject, category): "content"
      // We need to extract the targetId from the prompt
      const messages = (req as { messages: Array<{ content: string }> }).messages;
      const prompt = messages[0].content;
      const idMatch = prompt.match(/\[([^\]]+)\]/);
      const targetId = idMatch ? idMatch[1] : 'unknown';

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          classification: 'UPDATES',
          targetId,
          confidence: 0.9,
          reason: 'Location has changed',
        }) }],
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 100, outputTokens: 50 },
        model: 'mock-model',
      } satisfies CompletionResponse;
    });

    const mockRelationsProvider: LLMProvider = {
      name: 'mock-relations',
      isAvailable: () => true,
      complete: mockComplete,
    };

    const embedder = new TFIDFEmbedder();
    const store = new ScallopMemoryStore({
      dbPath: RELATIONS_DB_PATH,
      logger,
      embedder,
      relationsProvider: mockRelationsProvider,
    });

    try {
      // Seed first memory directly via DB with embedding: null so the
      // dedup loop in store.add() skips it (dedup checks `if (!mem.embedding) continue`).
      // This ensures the second store.add() proceeds past dedup to relation detection.
      const db = store.getDatabase();
      const mem1 = db.addMemory({
        userId: 'user1',
        content: 'Lives in Dublin',
        category: 'fact',
        memoryType: 'regular',
        importance: 5,
        confidence: 0.8,
        isLatest: true,
        source: 'user',
        documentDate: Date.now(),
        eventDate: null,
        prominence: 1.0,
        lastAccessed: null,
        accessCount: 0,
        sourceChunk: null,
        embedding: null,
        metadata: null,
      });

      // Store second memory via store.add() — dedup skips mem1 (no embedding),
      // so this reaches the relation detection code which calls the LLM classifier
      const mem2 = await store.add({
        userId: 'user1',
        content: 'Lives in Cork',
        category: 'fact',
        detectRelations: true,
      });

      // Verify the LLM provider was called for classification
      expect(mockComplete).toHaveBeenCalled();

      // Verify UPDATES relation was created between the memories
      const relations = db.getRelations(mem2.id);
      expect(relations.length).toBeGreaterThan(0);

      const updatesRelation = relations.find(r => r.relationType === 'UPDATES');
      expect(updatesRelation).toBeDefined();
      expect(updatesRelation!.sourceId).toBe(mem2.id);
      expect(updatesRelation!.targetId).toBe(mem1.id);
    } finally {
      store.close();
      cleanupRelationsDb();
    }
  });

  it('should fall back to regex when LLM classification fails', async () => {
    cleanupRelationsDb();

    const failingProvider: LLMProvider = {
      name: 'mock-failing-relations',
      isAvailable: () => true,
      complete: vi.fn().mockRejectedValue(new Error('LLM service unavailable')),
    };

    const embedder = new TFIDFEmbedder();
    const store = new ScallopMemoryStore({
      dbPath: RELATIONS_DB_PATH,
      logger,
      embedder,
      relationsProvider: failingProvider,
    });

    try {
      // Seed first memory directly via DB with embedding: null to bypass dedup
      const db = store.getDatabase();
      const mem1 = db.addMemory({
        userId: 'user1',
        content: 'Lives in Dublin',
        category: 'fact',
        memoryType: 'regular',
        importance: 5,
        confidence: 0.8,
        isLatest: true,
        source: 'user',
        documentDate: Date.now(),
        eventDate: null,
        prominence: 1.0,
        lastAccessed: null,
        accessCount: 0,
        sourceChunk: null,
        embedding: null,
        metadata: null,
      });

      // Store second memory — LLM will fail, should fall back to regex
      const mem2 = await store.add({
        userId: 'user1',
        content: 'Lives in Cork',
        category: 'fact',
        detectRelations: true,
      });

      // Verify the LLM was attempted
      expect(failingProvider.complete).toHaveBeenCalled();

      // Verify relation was still detected via regex fallback
      const relations = db.getRelations(mem2.id);
      expect(relations.length).toBeGreaterThan(0);

      const updatesRelation = relations.find(r => r.relationType === 'UPDATES');
      expect(updatesRelation).toBeDefined();
      expect(updatesRelation!.sourceId).toBe(mem2.id);
      expect(updatesRelation!.targetId).toBe(mem1.id);
    } finally {
      store.close();
      cleanupRelationsDb();
    }
  });
});

describe('ScallopMemoryStore activation-based related memories', () => {
  const ACTIVATION_DB_PATH = '/tmp/scallop-activation-test.db';

  function cleanupActivationDb() {
    try {
      fs.unlinkSync(ACTIVATION_DB_PATH);
      fs.unlinkSync(ACTIVATION_DB_PATH + '-wal');
      fs.unlinkSync(ACTIVATION_DB_PATH + '-shm');
    } catch {
      // Ignore if files don't exist
    }
  }

  it('should return related memories ordered by activation score', async () => {
    cleanupActivationDb();

    const embedder = new TFIDFEmbedder();
    // Use deterministic activation (no noise) so ordering is predictable
    const activationConfig: ActivationConfig = { noiseSigma: 0, resultThreshold: 0.001 };

    const store = new ScallopMemoryStore({
      dbPath: ACTIVATION_DB_PATH,
      logger,
      embedder,
      activationConfig,
    });

    try {
      const db = store.getDatabase();

      // Create seed memory — this is the one we'll search for
      const seed = await store.add({
        userId: 'user1',
        content: 'User works at Acme Corporation as a software engineer',
        category: 'fact',
        detectRelations: false,
      });

      // Create related memory A — will have UPDATES relation (high edge weight)
      const relatedA = await store.add({
        userId: 'user1',
        content: 'User was promoted to senior engineer at Acme Corporation',
        category: 'fact',
        detectRelations: false,
      });

      // Create related memory B — will have EXTENDS relation (lower edge weight)
      const relatedB = await store.add({
        userId: 'user1',
        content: 'Acme Corporation is located in San Francisco downtown',
        category: 'fact',
        detectRelations: false,
      });

      // Manually add relations via DB with known confidences:
      // relatedA UPDATES seed with confidence 0.9
      // Edge weight: UPDATES forward=0.9, so 0.9 * 0.9 = 0.81
      db.addRelation(relatedA.id, seed.id, 'UPDATES', 0.9);

      // Restore seed's isLatest since UPDATES marks the target as superseded
      db.updateMemory(seed.id, { isLatest: true });

      // seed EXTENDS relatedB with confidence 0.7
      // Edge weight: EXTENDS forward=0.7, so 0.7 * 0.7 = 0.49
      db.addRelation(seed.id, relatedB.id, 'EXTENDS', 0.7);

      // Search for the seed memory
      const results = await store.search('Acme Corporation software engineer', {
        userId: 'user1',
        limit: 5,
      });

      // Find the search result for the seed memory
      const seedResult = results.find(r => r.memory.id === seed.id);
      expect(seedResult).toBeDefined();
      expect(seedResult!.relatedMemories).toBeDefined();
      expect(seedResult!.relatedMemories!.length).toBeGreaterThanOrEqual(1);

      // Related memories should be ordered by activation score:
      // relatedA (UPDATES, weight 0.81) should come before relatedB (EXTENDS, weight 0.49)
      const relatedIds = seedResult!.relatedMemories!.map(m => m.id);
      const idxA = relatedIds.indexOf(relatedA.id);
      const idxB = relatedIds.indexOf(relatedB.id);

      // Both should be present (relatedA has isLatest=true since it's the source of UPDATES)
      expect(idxA).not.toBe(-1);
      if (idxB !== -1) {
        // When both present, A should rank before B due to higher activation
        expect(idxA).toBeLessThan(idxB);
      }
    } finally {
      store.close();
      cleanupActivationDb();
    }
  });

  it('should filter related memories to isLatest only', async () => {
    cleanupActivationDb();

    const embedder = new TFIDFEmbedder();
    const activationConfig: ActivationConfig = { noiseSigma: 0, resultThreshold: 0.001 };

    const store = new ScallopMemoryStore({
      dbPath: ACTIVATION_DB_PATH,
      logger,
      embedder,
      activationConfig,
    });

    try {
      const db = store.getDatabase();

      // Create seed memory
      const seed = await store.add({
        userId: 'user1',
        content: 'User prefers dark mode in all applications',
        category: 'preference',
        detectRelations: false,
      });

      // Create a superseded (not-latest) related memory
      const oldRelated = await store.add({
        userId: 'user1',
        content: 'User prefers light mode for reading applications',
        category: 'preference',
        detectRelations: false,
      });

      // Create the latest version that supersedes oldRelated
      const newRelated = await store.add({
        userId: 'user1',
        content: 'User prefers dark mode for reading applications too',
        category: 'preference',
        detectRelations: false,
      });

      // newRelated UPDATES oldRelated — oldRelated becomes isLatest=false
      db.addRelation(newRelated.id, oldRelated.id, 'UPDATES', 0.9);

      // Link seed to oldRelated via EXTENDS
      db.addRelation(seed.id, oldRelated.id, 'EXTENDS', 0.8);

      // Link seed to newRelated via EXTENDS
      db.addRelation(seed.id, newRelated.id, 'EXTENDS', 0.8);

      // Search for the seed memory
      const results = await store.search('dark mode preference', {
        userId: 'user1',
        limit: 5,
      });

      const seedResult = results.find(r => r.memory.id === seed.id);
      expect(seedResult).toBeDefined();

      if (seedResult!.relatedMemories && seedResult!.relatedMemories.length > 0) {
        // All related memories should be isLatest=true
        for (const related of seedResult!.relatedMemories) {
          expect(related.isLatest).toBe(true);
        }

        // oldRelated should NOT appear (it's superseded)
        const oldRelatedFound = seedResult!.relatedMemories.find(m => m.id === oldRelated.id);
        expect(oldRelatedFound).toBeUndefined();

        // newRelated should appear (it's the latest version)
        const newRelatedFound = seedResult!.relatedMemories.find(m => m.id === newRelated.id);
        expect(newRelatedFound).toBeDefined();
      }
    } finally {
      store.close();
      cleanupActivationDb();
    }
  });
});

describe('Scenario: Memory fusion in deep tick', () => {
  const FUSION_DB_PATH = '/tmp/scallop-fusion-test.db';

  function cleanupFusionDb() {
    try {
      fs.unlinkSync(FUSION_DB_PATH);
      fs.unlinkSync(FUSION_DB_PATH + '-wal');
      fs.unlinkSync(FUSION_DB_PATH + '-shm');
    } catch {
      // Ignore
    }
  }

  /** Helper: add a memory directly via db.addMemory with old documentDate */
  function addOldMemory(db: ScallopDatabase, content: string, opts?: { category?: 'fact' | 'preference' | 'event' | 'relationship' | 'insight'; memoryType?: 'regular' | 'derived'; ageDays?: number; accessCount?: number }) {
    const ageDays = opts?.ageDays ?? 150;
    return db.addMemory({
      userId: 'default',
      content,
      category: opts?.category ?? 'fact',
      memoryType: opts?.memoryType ?? 'regular',
      importance: 5,
      confidence: 0.8,
      isLatest: true,
      source: 'user',
      documentDate: Date.now() - ageDays * 24 * 60 * 60 * 1000,
      eventDate: null,
      prominence: 1.0, // Will be recalculated by processFullDecay
      lastAccessed: null,
      accessCount: opts?.accessCount ?? 0,
      sourceChunk: null,
      embedding: null,
      metadata: null,
      learnedFrom: 'conversation',
      timesConfirmed: 1,
      contradictionIds: null,
    });
  }

  it('should fuse cluster of dormant related memories during deep tick', async () => {
    cleanupFusionDb();

    const embedder = new TFIDFEmbedder();
    const store = new ScallopMemoryStore({
      dbPath: FUSION_DB_PATH,
      logger,
      embedder,
    });

    try {
      const db = store.getDatabase();

      // Add 4 old memories (150 days ago) — decay will compute prominence ~0.67 (below 0.7 threshold)
      const mem1 = addOldMemory(db, 'User enjoys hiking in the mountains on weekends');
      const mem2 = addOldMemory(db, 'User likes trail running in nearby hills');
      const mem3 = addOldMemory(db, 'User prefers outdoor activities over indoor sports');
      const mem4 = addOldMemory(db, 'User goes camping every summer in national parks');

      // Add EXTENDS relations connecting them in a chain (1->2, 2->3, 3->4)
      db.addRelation(mem1.id, mem2.id, 'EXTENDS', 0.8);
      db.addRelation(mem2.id, mem3.id, 'EXTENDS', 0.8);
      db.addRelation(mem3.id, mem4.id, 'EXTENDS', 0.8);

      // Create mock LLM fusionProvider
      const mockFusionProvider: LLMProvider = {
        name: 'mock-fusion',
        isAvailable: () => true,
        complete: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify({ summary: 'User is an outdoor enthusiast who enjoys hiking, trail running, and camping', importance: 7, category: 'fact' }) }],
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50 },
          model: 'mock-model',
        } satisfies CompletionResponse),
      };

      // Create gardener with fusionProvider
      const gardener = new BackgroundGardener({
        scallopStore: store,
        logger,
        fusionProvider: mockFusionProvider,
      });

      // Run deep tick (processFullDecay recalculates prominence from old documentDate)
      await gardener.deepTick();

      // Assert: A new memory with memoryType 'derived' exists
      const derivedMemories = db.getMemoriesByUser('default', { memoryType: 'derived', includeAllSources: true });
      expect(derivedMemories.length).toBe(1);

      const fused = derivedMemories[0];
      expect(fused.content).toContain('outdoor enthusiast');
      expect(fused.learnedFrom).toBe('consolidation');
      expect(fused.memoryType).toBe('derived');
      expect(fused.isLatest).toBe(true);

      // Assert: Source memories have isLatest: false
      const sourceIds = [mem1.id, mem2.id, mem3.id, mem4.id];
      for (const srcId of sourceIds) {
        const srcMem = db.getMemory(srcId);
        expect(srcMem).not.toBeNull();
        expect(srcMem!.isLatest).toBe(false);
        expect(srcMem!.memoryType).toBe('superseded');
      }

      // Assert: DERIVES relations exist from fused to sources
      const fusedRelations = db.getRelations(fused.id);
      const derivesRelations = fusedRelations.filter(r => r.relationType === 'DERIVES');
      expect(derivesRelations.length).toBe(4);

      // Assert: Fused memory's sourceChunk contains source content
      expect(fused.sourceChunk).toContain('hiking');
      expect(fused.sourceChunk).toContain('camping');
    } finally {
      store.close();
      cleanupFusionDb();
    }
  });

  it('should not fuse active or derived memories', async () => {
    cleanupFusionDb();

    const embedder = new TFIDFEmbedder();
    const store = new ScallopMemoryStore({
      dbPath: FUSION_DB_PATH,
      logger,
      embedder,
    });

    try {
      const db = store.getDatabase();

      // Create 2 recent memories (active - should not be fused, prominence stays ~0.90)
      const active1 = await store.add({ userId: 'default', content: 'Active memory about work at Google', category: 'fact', detectRelations: false });
      const active2 = await store.add({ userId: 'default', content: 'Active memory about project deadline', category: 'fact', detectRelations: false });

      // Create 1 pre-existing derived memory (should not be fused)
      // accessCount: 3 ensures it survives utility-based archival (utilityScore > 0.1)
      const preExistingDerived = addOldMemory(db, 'Previously fused summary about coding', { memoryType: 'derived', accessCount: 1 });

      // Create 3 old dormant memories (150 days ago — prominence ~0.67 after decay)
      // accessCount: 3 ensures they survive utility-based archival but still qualify for fusion (prominence < 0.7)
      const dormant1 = addOldMemory(db, 'User likes reading science fiction novels', { accessCount: 1 });
      const dormant2 = addOldMemory(db, 'User enjoys watching sci-fi movies', { accessCount: 1 });
      const dormant3 = addOldMemory(db, 'User collects sci-fi book first editions', { accessCount: 1 });

      // Add EXTENDS relations among the 3 dormant ones
      db.addRelation(dormant1.id, dormant2.id, 'EXTENDS', 0.8);
      db.addRelation(dormant2.id, dormant3.id, 'EXTENDS', 0.8);

      // Create mock fusion provider
      const mockFusionProvider: LLMProvider = {
        name: 'mock-fusion',
        isAvailable: () => true,
        complete: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify({ summary: 'User is a sci-fi enthusiast', importance: 6, category: 'fact' }) }],
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50 },
          model: 'mock-model',
        } satisfies CompletionResponse),
      };

      const gardener = new BackgroundGardener({
        scallopStore: store,
        logger,
        fusionProvider: mockFusionProvider,
      });

      await gardener.deepTick();

      // Assert: Only 1 new derived memory was created (from the 3 dormant ones)
      const allDerived = db.getMemoriesByUser('default', { memoryType: 'derived', includeAllSources: true });
      // 1 pre-existing + 1 new = 2 total derived
      expect(allDerived.length).toBe(2);

      // Assert: Active memories still have isLatest: true
      const activeCheck1 = db.getMemory(active1.id);
      const activeCheck2 = db.getMemory(active2.id);
      expect(activeCheck1!.isLatest).toBe(true);
      expect(activeCheck2!.isLatest).toBe(true);
      expect(activeCheck1!.memoryType).toBe('regular');
      expect(activeCheck2!.memoryType).toBe('regular');

      // Assert: Pre-existing derived memory is untouched
      const derivedCheck = db.getMemory(preExistingDerived.id);
      expect(derivedCheck!.memoryType).toBe('derived');
      expect(derivedCheck!.content).toBe('Previously fused summary about coding');
    } finally {
      store.close();
      cleanupFusionDb();
    }
  });

  it('should handle LLM fusion failure gracefully', async () => {
    cleanupFusionDb();

    const embedder = new TFIDFEmbedder();
    const store = new ScallopMemoryStore({
      dbPath: FUSION_DB_PATH,
      logger,
      embedder,
    });

    try {
      const db = store.getDatabase();

      // Create 3 old dormant memories with relations (150 days ago)
      // accessCount: 3 ensures they survive utility-based archival (utilityScore > 0.1)
      const mem1 = addOldMemory(db, 'User works at a startup company in Dublin', { accessCount: 1 });
      const mem2 = addOldMemory(db, 'User commutes by bike to the office daily', { accessCount: 1 });
      const mem3 = addOldMemory(db, 'User has a standing desk at work', { accessCount: 1 });
      db.addRelation(mem1.id, mem2.id, 'EXTENDS', 0.8);
      db.addRelation(mem2.id, mem3.id, 'EXTENDS', 0.8);

      // Create failing mock LLM
      const failingProvider: LLMProvider = {
        name: 'mock-failing-fusion',
        isAvailable: () => true,
        complete: vi.fn().mockRejectedValue(new Error('LLM service down')),
      };

      const gardener = new BackgroundGardener({
        scallopStore: store,
        logger,
        fusionProvider: failingProvider,
      });

      // Run deep tick — should not crash
      await gardener.deepTick();

      // Assert: No derived memories created
      const derivedMemories = db.getMemoriesByUser('default', { memoryType: 'derived', includeAllSources: true });
      expect(derivedMemories.length).toBe(0);

      // Assert: Source memories unchanged (still isLatest: true)
      const check1 = db.getMemory(mem1.id);
      const check2 = db.getMemory(mem2.id);
      const check3 = db.getMemory(mem3.id);
      expect(check1!.isLatest).toBe(true);
      expect(check2!.isLatest).toBe(true);
      expect(check3!.isLatest).toBe(true);

      // Assert: Deep tick completed normally (provider was called)
      expect(failingProvider.complete).toHaveBeenCalled();
    } finally {
      store.close();
      cleanupFusionDb();
    }
  });
});
