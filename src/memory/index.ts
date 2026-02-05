export {
  MemoryStore,
  HotCollector,
  BackgroundGardener,
  HybridSearch,
  extractFacts,
  summarizeMemories,
  calculateBM25Score,
  type MemoryEntry,
  type MemoryType,
  type PartialMemoryEntry,
  type MemoryStoreOptions,
  type CollectOptions,
  type HotCollectorOptions,
  type BackgroundGardenerOptions,
  type BM25Options,
  type SearchResult,
  type SearchOptions,
  type HybridSearchOptions,
  type ExtractedFact,
} from './memory.js';

// Embeddings
export {
  TFIDFEmbedder,
  OpenAIEmbedder,
  OllamaEmbedder,
  FallbackEmbedder,
  EmbeddingCache,
  cosineSimilarity,
  euclideanDistance,
  createDefaultEmbedder,
  createOpenAIEmbedder,
  createOllamaEmbedder,
  type EmbeddingProvider,
  type OpenAIEmbedderOptions,
  type OllamaEmbedderOptions,
} from './embeddings.js';

// LLM-based fact extraction
export {
  LLMFactExtractor,
  extractFactsWithLLM,
  type ExtractedFactWithEmbedding,
  type FactExtractionResult,
  type FactCategory,
  type LLMFactExtractorOptions,
} from './fact-extractor.js';

// ============ ScallopMemory System ============

// SQLite Database Layer
export {
  ScallopDatabase,
  createDatabase,
  type ScallopMemoryEntry,
  type ScallopMemoryType,
  type MemoryCategory,
  type RelationType,
  type MemoryRelation,
  type UserProfileEntry,
  type DynamicProfile,
  type BehavioralPatterns,
} from './db.js';

// Decay Engine
export {
  DecayEngine,
  createDecayEngine,
  PROMINENCE_THRESHOLDS,
  type DecayConfig,
} from './decay.js';

// Memory Relations
export {
  RelationGraph,
  createRelationGraph,
  type RelationDetectionOptions,
  type DetectedRelation,
} from './relations.js';

// User Profiles
export {
  ProfileManager,
  createProfileManager,
  type FullUserProfile,
  type ProfileContext,
  type ProfileUpdateOptions,
} from './profiles.js';

// Temporal Grounding
export {
  TemporalExtractor,
  TemporalQuery,
  createTemporalExtractor,
  type TemporalExtraction,
  type DateLocale,
  type TemporalExtractorOptions,
} from './temporal.js';

// Migration
export {
  migrateJsonlToSqlite,
  verifyMigration,
  rollbackMigration,
  type MigrationOptions,
  type MigrationResult,
} from './migrate.js';

// Main ScallopMemoryStore
export {
  ScallopMemoryStore,
  createScallopMemoryStore,
  type ScallopMemoryStoreOptions,
  type AddMemoryOptions,
  type ScallopSearchOptions,
  type ScallopSearchResult,
} from './scallop-store.js';
