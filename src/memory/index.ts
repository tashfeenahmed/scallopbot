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

// NREM Consolidation
export {
  nremConsolidate,
  buildNremFusionPrompt,
  buildRelationContext,
  DEFAULT_NREM_CONFIG,
  type NremConfig,
  type NremResult,
  type RelationContextEntry,
} from './nrem-consolidation.js';

// REM Exploration
export {
  remExplore,
  sampleSeeds,
  DEFAULT_REM_CONFIG,
  type RemConfig,
  type RemExplorationResult,
  type RemDiscovery,
} from './rem-exploration.js';

// Dream Orchestrator
export {
  dream,
  type DreamConfig,
  type DreamResult,
} from './dream.js';

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

// Affect EMA Smoothing
export {
  createInitialAffectState,
  updateAffectEMA,
  deriveGoalSignal,
  getSmoothedAffect,
  type AffectEMAState,
  type GoalSignal,
  type SmoothedAffect,
} from './affect-smoothing.js';

// Affect Lexicon Resources
export {
  AROUSAL_MAP,
  NEGATION_WORDS,
  BOOSTER_DICT,
  EMOJI_VALENCE,
  N_SCALAR,
} from './affect-lexicon.js';

// Self-Reflection
export {
  reflect,
  buildReflectionPrompt,
  buildSoulDistillationPrompt,
  DEFAULT_REFLECTION_CONFIG,
  type ReflectionConfig,
  type ReflectionResult,
  type ReflectionInsight,
} from './reflection.js';

// Utility Score (Enhanced Forgetting)
export {
  computeUtilityScore,
  findLowUtilityMemories,
  archiveLowUtilityMemories,
  pruneOrphanedRelations,
  type LowUtilityMemory,
  type FindLowUtilityOptions,
  type ArchiveOptions,
  type ArchiveResult,
} from './utility-score.js';

// Gap Scanner (Stage 1: Signal Heuristics)
export {
  scanForGaps,
  scanStaleGoals,
  scanBehavioralAnomalies,
  scanUnresolvedThreads,
  type GapSignal,
  type GapScanInput,
} from './gap-scanner.js';

// Gap Diagnosis (Stage 2: LLM Triage)
export {
  diagnoseGaps,
  buildGapDiagnosisPrompt,
  parseGapDiagnosis,
  type DiagnosedGap,
  type UserContext,
} from './gap-diagnosis.js';

// Gap Actions (Stage 3: Proactiveness-Gated Actions)
export {
  createGapActions,
  DIAL_THRESHOLDS,
  type GapAction,
} from './gap-actions.js';

// Inner Thoughts (Post-session proactive evaluation)
export {
  evaluateInnerThoughts,
  shouldRunInnerThoughts,
  buildInnerThoughtsPrompt,
  parseInnerThoughtsResponse,
  type InnerThoughtsInput,
  type InnerThoughtsResult,
} from './inner-thoughts.js';

// Gardener shared helpers
export { type GardenerContext, safeBehavioralPatterns } from './gardener-context.js';
export { scheduleProactiveItem, getLastProactiveAt } from './gardener-scheduling.js';
export { storeFusedMemory } from './gardener-fusion-storage.js';
