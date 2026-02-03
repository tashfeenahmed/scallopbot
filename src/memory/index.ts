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
