/**
 * Tests for Dream Orchestrator
 *
 * Tests the unified dream cycle coordinator that runs NREM consolidation
 * followed by REM exploration:
 * - Sequential execution (NREM before REM)
 * - Skip flags (skipNrem, skipRem, both)
 * - Phase isolation (NREM failure doesn't block REM, REM failure preserves NREM)
 * - Empty memories input
 * - Config passthrough to NREM/REM
 * - Same provider for both phases
 */

import { describe, it, expect, vi } from 'vitest';
import type { ScallopMemoryEntry, MemoryRelation, MemoryCategory } from './db.js';
import type { LLMProvider, CompletionResponse } from '../providers/types.js';
import { dream, type DreamConfig, type DreamResult } from './dream.js';

// ============ Test Helpers ============

/** Create a minimal ScallopMemoryEntry for testing */
function makeMemory(overrides: Partial<ScallopMemoryEntry> & { id: string }): ScallopMemoryEntry {
  return {
    userId: 'default',
    content: `Memory content for ${overrides.id}`,
    category: 'fact' as MemoryCategory,
    memoryType: 'regular',
    importance: 5,
    confidence: 0.8,
    isLatest: true,
    documentDate: Date.now() - 86400000,
    eventDate: null,
    prominence: 0.3,
    lastAccessed: null,
    accessCount: 0,
    sourceChunk: null,
    embedding: null,
    metadata: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

/** Create a mock LLMProvider */
function createMockProvider(responseText: string): LLMProvider {
  return {
    name: 'mock',
    isAvailable: () => true,
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: responseText }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
      model: 'mock-model',
    } satisfies CompletionResponse),
  };
}

/** Create a mock provider that throws an error */
function createFailingProvider(errorMessage: string): LLMProvider {
  return {
    name: 'mock-failing',
    isAvailable: () => true,
    complete: vi.fn().mockRejectedValue(new Error(errorMessage)),
  };
}

/** Build a getRelations callback from a list of relations */
function buildGetRelations(relations: MemoryRelation[]): (memoryId: string) => MemoryRelation[] {
  return (memoryId: string) =>
    relations.filter(r => r.sourceId === memoryId || r.targetId === memoryId);
}

// ============ Mock nremConsolidate and remExplore ============

// We mock the underlying modules so dream.ts is tested in isolation
// as a pure coordinator, without requiring real LLM responses or
// complex memory/relation setups for each test.

vi.mock('./nrem-consolidation.js', () => ({
  nremConsolidate: vi.fn(),
}));

vi.mock('./rem-exploration.js', () => ({
  remExplore: vi.fn(),
}));

import { nremConsolidate } from './nrem-consolidation.js';
import { remExplore } from './rem-exploration.js';
import type { NremResult } from './nrem-consolidation.js';
import type { RemExplorationResult } from './rem-exploration.js';

const mockNremConsolidate = vi.mocked(nremConsolidate);
const mockRemExplore = vi.mocked(remExplore);

// ============ Test Data ============

const EMPTY_NREM_RESULT: NremResult = {
  clustersProcessed: 0,
  fusionResults: [],
  failures: 0,
};

const SAMPLE_NREM_RESULT: NremResult = {
  clustersProcessed: 2,
  fusionResults: [
    {
      summary: 'Consolidated memory about testing patterns',
      importance: 7,
      category: 'insight',
      confidence: 0.8,
      learnedFrom: 'nrem_consolidation',
      sourceMemoryIds: ['m1', 'm2', 'm3'],
    },
  ],
  failures: 1,
};

const EMPTY_REM_RESULT: RemExplorationResult = {
  seedsExplored: 0,
  candidatesEvaluated: 0,
  discoveries: [],
  failures: 0,
};

const SAMPLE_REM_RESULT: RemExplorationResult = {
  seedsExplored: 3,
  candidatesEvaluated: 5,
  discoveries: [
    {
      seedId: 'm1',
      neighborId: 'm4',
      connectionDescription: 'Both relate to code quality patterns',
      confidence: 0.7,
      noveltyScore: 4,
      plausibilityScore: 3,
      usefulnessScore: 4,
    },
  ],
  failures: 0,
};

// ============ Tests ============

describe('dream orchestrator', () => {
  const memories = [
    makeMemory({ id: 'm1' }),
    makeMemory({ id: 'm2' }),
    makeMemory({ id: 'm3' }),
  ];
  const getRelations = buildGetRelations([]);
  const nremProvider = createMockProvider('unused');
  const remProvider = createMockProvider('unused');

  beforeEach(() => {
    vi.clearAllMocks();
    mockNremConsolidate.mockResolvedValue(SAMPLE_NREM_RESULT);
    mockRemExplore.mockResolvedValue(SAMPLE_REM_RESULT);
  });

  // ============ Sequential Execution ============

  describe('sequential execution', () => {
    it('runs NREM before REM', async () => {
      const callOrder: string[] = [];

      mockNremConsolidate.mockImplementation(async () => {
        callOrder.push('nrem');
        return SAMPLE_NREM_RESULT;
      });
      mockRemExplore.mockImplementation(async () => {
        callOrder.push('rem');
        return SAMPLE_REM_RESULT;
      });

      await dream(memories, getRelations, nremProvider, remProvider);

      expect(callOrder).toEqual(['nrem', 'rem']);
    });

    it('returns combined results from both phases', async () => {
      const result = await dream(memories, getRelations, nremProvider, remProvider);

      expect(result.nrem).toEqual(SAMPLE_NREM_RESULT);
      expect(result.rem).toEqual(SAMPLE_REM_RESULT);
    });

    it('passes correct arguments to nremConsolidate', async () => {
      await dream(memories, getRelations, nremProvider, remProvider);

      expect(mockNremConsolidate).toHaveBeenCalledWith(
        memories,
        getRelations,
        nremProvider,
        undefined,
      );
    });

    it('passes correct arguments to remExplore', async () => {
      await dream(memories, getRelations, nremProvider, remProvider);

      expect(mockRemExplore).toHaveBeenCalledWith(
        memories,
        getRelations,
        remProvider,
        undefined,
      );
    });
  });

  // ============ Skip Flags ============

  describe('skip flags', () => {
    it('skips NREM when skipNrem is true', async () => {
      const result = await dream(memories, getRelations, nremProvider, remProvider, {
        skipNrem: true,
      });

      expect(mockNremConsolidate).not.toHaveBeenCalled();
      expect(mockRemExplore).toHaveBeenCalled();
      expect(result.nrem).toBeNull();
      expect(result.rem).toEqual(SAMPLE_REM_RESULT);
    });

    it('skips REM when skipRem is true', async () => {
      const result = await dream(memories, getRelations, nremProvider, remProvider, {
        skipRem: true,
      });

      expect(mockNremConsolidate).toHaveBeenCalled();
      expect(mockRemExplore).not.toHaveBeenCalled();
      expect(result.nrem).toEqual(SAMPLE_NREM_RESULT);
      expect(result.rem).toBeNull();
    });

    it('skips both when both flags are true', async () => {
      const result = await dream(memories, getRelations, nremProvider, remProvider, {
        skipNrem: true,
        skipRem: true,
      });

      expect(mockNremConsolidate).not.toHaveBeenCalled();
      expect(mockRemExplore).not.toHaveBeenCalled();
      expect(result.nrem).toBeNull();
      expect(result.rem).toBeNull();
    });

    it('runs both when no skip flags are set', async () => {
      const result = await dream(memories, getRelations, nremProvider, remProvider, {});

      expect(mockNremConsolidate).toHaveBeenCalled();
      expect(mockRemExplore).toHaveBeenCalled();
      expect(result.nrem).toEqual(SAMPLE_NREM_RESULT);
      expect(result.rem).toEqual(SAMPLE_REM_RESULT);
    });
  });

  // ============ Phase Isolation ============

  describe('phase isolation', () => {
    it('NREM failure does not block REM', async () => {
      mockNremConsolidate.mockRejectedValue(new Error('NREM provider crashed'));

      const result = await dream(memories, getRelations, nremProvider, remProvider);

      expect(result.nrem).toBeNull();
      expect(result.rem).toEqual(SAMPLE_REM_RESULT);
      expect(mockRemExplore).toHaveBeenCalled();
    });

    it('REM failure preserves NREM results', async () => {
      mockRemExplore.mockRejectedValue(new Error('REM provider crashed'));

      const result = await dream(memories, getRelations, nremProvider, remProvider);

      expect(result.nrem).toEqual(SAMPLE_NREM_RESULT);
      expect(result.rem).toBeNull();
    });

    it('both failures return both null', async () => {
      mockNremConsolidate.mockRejectedValue(new Error('NREM failed'));
      mockRemExplore.mockRejectedValue(new Error('REM failed'));

      const result = await dream(memories, getRelations, nremProvider, remProvider);

      expect(result.nrem).toBeNull();
      expect(result.rem).toBeNull();
    });
  });

  // ============ Empty Memories ============

  describe('empty memories', () => {
    it('passes empty array to both phases', async () => {
      mockNremConsolidate.mockResolvedValue(EMPTY_NREM_RESULT);
      mockRemExplore.mockResolvedValue(EMPTY_REM_RESULT);

      const result = await dream([], getRelations, nremProvider, remProvider);

      expect(mockNremConsolidate).toHaveBeenCalledWith(
        [],
        getRelations,
        nremProvider,
        undefined,
      );
      expect(mockRemExplore).toHaveBeenCalledWith(
        [],
        getRelations,
        remProvider,
        undefined,
      );
      expect(result.nrem).toEqual(EMPTY_NREM_RESULT);
      expect(result.rem).toEqual(EMPTY_REM_RESULT);
    });
  });

  // ============ Config Passthrough ============

  describe('config passthrough', () => {
    it('passes nrem config to nremConsolidate', async () => {
      const nremConfig = { maxClusters: 5, minClusterSize: 2 };

      await dream(memories, getRelations, nremProvider, remProvider, {
        nrem: nremConfig,
      });

      expect(mockNremConsolidate).toHaveBeenCalledWith(
        memories,
        getRelations,
        nremProvider,
        nremConfig,
      );
    });

    it('passes rem config to remExplore', async () => {
      const remConfig = { maxSeeds: 3, noiseSigma: 0.8 };

      await dream(memories, getRelations, nremProvider, remProvider, {
        rem: remConfig,
      });

      expect(mockRemExplore).toHaveBeenCalledWith(
        memories,
        getRelations,
        remProvider,
        remConfig,
      );
    });

    it('passes both configs simultaneously', async () => {
      const nremConfig = { maxClusters: 5 };
      const remConfig = { maxSeeds: 3 };

      await dream(memories, getRelations, nremProvider, remProvider, {
        nrem: nremConfig,
        rem: remConfig,
      });

      expect(mockNremConsolidate).toHaveBeenCalledWith(
        memories,
        getRelations,
        nremProvider,
        nremConfig,
      );
      expect(mockRemExplore).toHaveBeenCalledWith(
        memories,
        getRelations,
        remProvider,
        remConfig,
      );
    });

    it('does not pass config when not provided', async () => {
      await dream(memories, getRelations, nremProvider, remProvider);

      expect(mockNremConsolidate).toHaveBeenCalledWith(
        memories,
        getRelations,
        nremProvider,
        undefined,
      );
      expect(mockRemExplore).toHaveBeenCalledWith(
        memories,
        getRelations,
        remProvider,
        undefined,
      );
    });
  });

  // ============ Same Provider for Both ============

  describe('same provider for both phases', () => {
    it('works when same provider is used for NREM and REM', async () => {
      const sharedProvider = createMockProvider('shared');

      const result = await dream(memories, getRelations, sharedProvider, sharedProvider);

      expect(mockNremConsolidate).toHaveBeenCalledWith(
        memories,
        getRelations,
        sharedProvider,
        undefined,
      );
      expect(mockRemExplore).toHaveBeenCalledWith(
        memories,
        getRelations,
        sharedProvider,
        undefined,
      );
      expect(result.nrem).toEqual(SAMPLE_NREM_RESULT);
      expect(result.rem).toEqual(SAMPLE_REM_RESULT);
    });
  });

  // ============ Default Config ============

  describe('no config provided', () => {
    it('runs both phases with no config override', async () => {
      const result = await dream(memories, getRelations, nremProvider, remProvider);

      expect(result.nrem).not.toBeNull();
      expect(result.rem).not.toBeNull();
    });
  });
});
