/**
 * Tests for ScallopMemory System
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  PROMINENCE_THRESHOLDS,
} from './index.js';
import pino from 'pino';

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
    expect(prominence).toBeLessThan(0.8); // Should have decayed
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
});

describe('TemporalExtractor', () => {
  let extractor: TemporalExtractor;
  const refDate = new Date('2026-02-03T12:00:00Z');

  beforeEach(() => {
    extractor = new TemporalExtractor(refDate);
  });

  it('should extract relative dates', () => {
    const tomorrow = extractor.extract('Meeting tomorrow at 3pm');
    expect(tomorrow.eventDate).not.toBeNull();

    const tomorrowDate = new Date(tomorrow.eventDate!);
    expect(tomorrowDate.getDate()).toBe(4); // Feb 4
  });

  it('should extract "next week"', () => {
    const result = extractor.extract('Conference next week');
    expect(result.eventDate).not.toBeNull();

    const eventDate = new Date(result.eventDate!);
    const expectedDate = new Date(refDate);
    expectedDate.setDate(expectedDate.getDate() + 7);

    expect(eventDate.getDate()).toBe(expectedDate.getDate());
  });

  it('should extract "3 days ago"', () => {
    const result = extractor.extract('Finished the project 3 days ago');
    expect(result.eventDate).not.toBeNull();

    const eventDate = new Date(result.eventDate!);
    const expectedDate = new Date(refDate);
    expectedDate.setDate(expectedDate.getDate() - 3);

    expect(eventDate.getDate()).toBe(expectedDate.getDate());
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
