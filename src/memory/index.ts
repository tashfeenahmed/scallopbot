// Legacy types
export {
  type MemoryEntry,
  type MemoryType,
  type PartialMemoryEntry,
} from './legacy-types.js';

// BM25 scoring
export {
  calculateBM25Score,
  buildDocFreqMap,
  SEARCH_WEIGHTS,
  type BM25Options,
} from './bm25.js';

// Memory system (BackgroundGardener)
export {
  BackgroundGardener,
  type BackgroundGardenerOptions,
} from './memory.js';

// Embeddings
export {
  TFIDFEmbedder,
  OpenAIEmbedder,
  OllamaEmbedder,
  FallbackEmbedder,
  CachedEmbedder,
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

// Session Summarizer
export {
  SessionSummarizer,
  type SessionSummarizerOptions,
  type SessionSummaryResult,
} from './session-summary.js';

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
  type SessionSummaryRow,
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
  type ActivationConfig,
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

// Memory Fusion
export {
  findFusionClusters,
  fuseMemoryCluster,
  buildFusionPrompt,
  DEFAULT_FUSION_CONFIG,
  type FusionConfig,
  type FusionResult,
} from './fusion.js';

// Behavioral Signals
export {
  computeMessageFrequency,
  computeSessionEngagement,
  computeTopicSwitchRate,
  computeResponseLengthEvolution,
  updateEMA,
  detectTrend,
  type MessageFrequencySignal,
  type SessionEngagementSignal,
  type TopicSwitchSignal,
  type ResponseLengthSignal,
  type BehavioralSignals,
} from './behavioral-signals.js';

// Health Ping
export {
  performHealthPing,
  type HealthPingResult,
} from './health-ping.js';

// Retrieval Audit
export {
  auditRetrievalHistory,
  type RetrievalAuditResult,
} from './retrieval-audit.js';

// Trust Score
export {
  computeTrustScore,
  type TrustScoreResult,
  type TrustSignals,
} from './trust-score.js';

// Goal Deadline Check
export {
  checkGoalDeadlines,
  type GoalDeadlineResult,
} from './goal-deadline-check.js';

// Affect Detection
export {
  classifyAffect,
  mapToEmotion,
  type RawAffect,
  type EmotionLabel,
} from './affect.js';
