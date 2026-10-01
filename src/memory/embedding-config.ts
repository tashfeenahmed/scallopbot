/**
 * Embedding provider selection (EMBEDDING_PROVIDER / EMBEDDING_MODEL).
 *
 * Every stored vector is tagged with the "embedding model key" of the provider
 * that produced it (e.g. `ollama:nomic-embed-text`). Vectors from different
 * keys live in different spaces and are never compared; see
 * ScallopDatabase.setEmbeddingModel and reembed.ts.
 *
 * The provider is fixed for the life of the process. If Ollama is unreachable
 * at startup we fall back to TF-IDF for that run (warning when Ollama was
 * explicitly requested) instead of mixing spaces mid-run.
 *
 * transformers.js (in-process ONNX) was considered and skipped: it pulls in
 * onnxruntime-node (~100 MB+ of native binaries, no reliable armv7 build) and
 * loads the model into the bot's own heap, which is a poor trade on a
 * Raspberry Pi when Ollama can serve the same models out of process.
 */

import {
  OllamaEmbedder,
  OpenAIEmbedder,
  TFIDFEmbedder,
  type EmbeddingProvider,
} from './embeddings.js';

export type EmbeddingProviderName = 'tfidf' | 'openai' | 'ollama';

export const DEFAULT_OLLAMA_EMBEDDING_MODEL = 'nomic-embed-text';
export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
export const TFIDF_EMBEDDING_KEY = 'tfidf:v1';
/**
 * Before vectors were tagged, the gateway only ever wrote Ollama
 * nomic-embed-text (768-dim) vectors; the DB migration tags those with this key.
 */
export const LEGACY_EMBEDDING_KEY = `ollama:${DEFAULT_OLLAMA_EMBEDDING_MODEL}`;
export const LEGACY_EMBEDDING_DIMENSION = 768;

export interface EmbeddingSettings {
  /** `auto` = EMBEDDING_PROVIDER unset: try Ollama, quietly fall back to TF-IDF. */
  provider: EmbeddingProviderName | 'auto';
  model?: string;
  /** Set when EMBEDDING_PROVIDER held an unknown value. */
  invalidValue?: string;
}

export function resolveEmbeddingSettings(env: NodeJS.ProcessEnv = process.env): EmbeddingSettings {
  const raw = (env.EMBEDDING_PROVIDER ?? '').trim().toLowerCase();
  const model = env.EMBEDDING_MODEL?.trim() || undefined;
  if (!raw || raw === 'auto') return { provider: 'auto', model };
  if (raw === 'tfidf' || raw === 'openai' || raw === 'ollama') return { provider: raw, model };
  return { provider: 'auto', model, invalidValue: raw };
}

export function embeddingModelKey(provider: EmbeddingProviderName, model?: string): string {
  if (provider === 'tfidf') return TFIDF_EMBEDDING_KEY;
  if (provider === 'openai') return `openai:${model || DEFAULT_OPENAI_EMBEDDING_MODEL}`;
  return `ollama:${model || DEFAULT_OLLAMA_EMBEDDING_MODEL}`;
}

export interface ConfiguredEmbedder {
  embedder: EmbeddingProvider;
  /** Tag written next to every vector this embedder produces. */
  key: string;
  provider: EmbeddingProviderName;
  model?: string;
  /** True when the requested provider was unavailable and TF-IDF is used instead. */
  fellBack: boolean;
  reason?: string;
}

export interface EmbedderLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface CreateEmbedderOptions {
  env?: NodeJS.ProcessEnv;
  ollamaBaseUrl?: string;
  openaiApiKey?: string;
  logger?: EmbedderLogger;
  /** Startup reachability probe deadline for Ollama (default 15s; first load can be slow on a Pi). */
  probeTimeoutMs?: number;
}

function tfidf(reason?: string, fellBack = false): ConfiguredEmbedder {
  return {
    embedder: new TFIDFEmbedder(),
    key: TFIDF_EMBEDDING_KEY,
    provider: 'tfidf',
    fellBack,
    reason,
  };
}

/**
 * Build the process-wide embedder from EMBEDDING_PROVIDER / EMBEDDING_MODEL.
 * Never throws: any failure degrades to TF-IDF.
 */
export async function createConfiguredEmbedder(options: CreateEmbedderOptions = {}): Promise<ConfiguredEmbedder> {
  const env = options.env ?? process.env;
  const settings = resolveEmbeddingSettings(env);
  const logger = options.logger;
  if (settings.invalidValue) {
    logger?.warn(
      { value: settings.invalidValue },
      'Unknown EMBEDDING_PROVIDER (expected tfidf|openai|ollama); using auto',
    );
  }

  if (settings.provider === 'tfidf') return tfidf();

  if (settings.provider === 'openai') {
    const apiKey = options.openaiApiKey ?? env.OPENAI_API_KEY;
    if (!apiKey) {
      const reason = 'EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not set';
      logger?.warn({}, `${reason}; falling back to TF-IDF embeddings`);
      return tfidf(reason, true);
    }
    const model = settings.model || DEFAULT_OPENAI_EMBEDDING_MODEL;
    return {
      embedder: new OpenAIEmbedder({ apiKey, model }),
      key: embeddingModelKey('openai', model),
      provider: 'openai',
      model,
      fellBack: false,
    };
  }

  // ollama (explicit) or auto
  const model = settings.model || DEFAULT_OLLAMA_EMBEDDING_MODEL;
  const baseUrl = options.ollamaBaseUrl || env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const probe = new OllamaEmbedder({ baseUrl, model, timeoutMs: options.probeTimeoutMs ?? 15_000 });
  try {
    await probe.embed('ping');
  } catch (error) {
    const reason = `Ollama embeddings unavailable at ${baseUrl} (${(error as Error).message})`;
    if (settings.provider === 'ollama') {
      logger?.warn({ baseUrl, model }, `${reason}; falling back to TF-IDF embeddings for this run`);
    } else {
      logger?.info({ baseUrl, model }, `${reason}; using TF-IDF embeddings (set EMBEDDING_PROVIDER to choose)`);
    }
    return tfidf(reason, true);
  }
  const embedder = new OllamaEmbedder({ baseUrl, model });
  embedder.dimension = probe.dimension;
  logger?.info({ baseUrl, model, dimension: probe.dimension }, 'Using Ollama for memory embeddings');
  return {
    embedder,
    key: embeddingModelKey('ollama', model),
    provider: 'ollama',
    model,
    fellBack: false,
  };
}
