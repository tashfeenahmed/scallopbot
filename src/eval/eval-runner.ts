/**
 * Eval Runner — Simulation Orchestrator
 *
 * Runs a 30-day simulation for a given mode configuration.
 * For each day:
 *   1. Sets simulated time
 *   2. Ingests conversations (Mem0: LLM fact extraction + LLM dedup; others: raw append)
 *   3. Runs light ticks (decay) if enabled
 *   4. Runs deep tick (fusion, proactive) if enabled
 *   5. Runs sleep tick (dreams, reflection, gap scanner) if enabled
 *   6. Collects metrics
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { vi } from 'vitest';
import dotenv from 'dotenv';
import { ScallopMemoryStore } from '../memory/scallop-store.js';
import { ScallopDatabase } from '../memory/db.js';
import { BackgroundGardener } from '../memory/memory.js';
import { classifyAffect, type EmotionLabel } from '../memory/affect.js';
import { createInitialAffectState, updateAffectEMA, getSmoothedAffect } from '../memory/affect-smoothing.js';
import { testLogger } from '../e2e/helpers.js';
import { type CognitiveCallLogEntry } from './mock-cognitive.js';
import { collectDayMetrics, type DayMetrics } from './metrics.js';
import { getQueriesForDay, type SimulatedDay } from './scenarios.js';
import { type EvalModeConfig, createModeSearch } from './modes.js';
import { cosineSimilarity, OllamaEmbedder, type EmbeddingProvider } from '../memory/embeddings.js';
import { MoonshotProvider } from '../providers/moonshot.js';
import type { LLMProvider, CompletionRequest, CompletionResponse, ContentBlock } from '../providers/types.js';

// ============ Environment ============

// Load .env from project root so API keys are available in vitest
dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });

// ============ Tracked LLM Provider ============

/**
 * Wraps a real LLMProvider with call logging for metrics collection.
 * Same interface as CognitiveMockProvider so metrics.ts works unchanged.
 */
interface TrackedProvider extends LLMProvider {
  callLog: CognitiveCallLogEntry[];
  callCount: number;
}

function detectOperationType(request: CompletionRequest): string {
  const sys = (request.system ?? '').toLowerCase();
  if (sys.includes('nrem') || (sys.includes('deep sleep') && sys.includes('consolidat'))) return 'nrem';
  if (sys.includes('fuse') || sys.includes('fusion') || sys.includes('consolidat') || sys.includes('merge memories')) return 'fusion';
  if (sys.includes('novelty') && sys.includes('plausibility')) return 'rem_judge';
  if (sys.includes('guidelines distiller') || sys.includes('soul')) return 'soul';
  if (sys.includes('self-reflection') || (sys.includes('reflection') && sys.includes('insight'))) return 'reflection';
  if (sys.includes('diagnos') && sys.includes('gap')) return 'gap_diagnosis';
  if (sys.includes('inner') && sys.includes('proactive')) return 'inner_thoughts';
  if (sys.includes('summarize') || (sys.includes('summary') && sys.includes('session'))) return 'summarize';
  if (sys.includes('re-rank') || sys.includes('rerank') || sys.includes('relevance')) return 'rerank';
  return 'default';
}

function createTrackedProvider(inner: LLMProvider): TrackedProvider {
  return {
    name: inner.name,
    callLog: [],
    callCount: 0,
    isAvailable() { return inner.isAvailable(); },
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      this.callCount++;
      const operation = detectOperationType(request);
      this.callLog.push({ operation, timestamp: Date.now() });
      return inner.complete(request);
    },
  };
}

// ============ Provider Factory ============

interface EvalProviders {
  embedder: EmbeddingProvider;
  llmProvider: TrackedProvider;
}

function createEvalProviders(): EvalProviders {
  const moonshotKey = process.env.MOONSHOT_API_KEY;
  if (!moonshotKey) {
    throw new Error('MOONSHOT_API_KEY not found in environment. Add it to .env in the project root.');
  }

  const embedder = new OllamaEmbedder({
    baseUrl: 'http://localhost:11434',
    model: 'nomic-embed-text',
  });

  const moonshot = new MoonshotProvider({
    apiKey: moonshotKey,
    model: 'kimi-k2.5',
    timeout: 30_000,
  });

  return {
    embedder,
    llmProvider: createTrackedProvider(moonshot),
  };
}

// ============ Constants ============

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const BASE_DATE = new Date('2025-02-01T00:00:00Z').getTime();
const USER_ID = 'default';

// ============ Runner ============

/**
 * Run the full eval simulation for a single mode.
 */
export async function runEval(
  mode: EvalModeConfig,
  scenarios: SimulatedDay[],
): Promise<DayMetrics[]> {
  // Create isolated DB in /tmp
  const dbPath = `/tmp/eval-${mode.name}-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`;

  // Real providers: Ollama nomic-embed-text for embeddings, Moonshot Kimi for LLM
  const { embedder, llmProvider } = createEvalProviders();

  // Build store with mode-specific config
  const store = new ScallopMemoryStore({
    dbPath,
    logger: testLogger,
    embedder,
    decayConfig: mode.enableDecay ? mode.decayOverrides : { baseDecayRate: 1.0 },
    rerankProvider: mode.enableReranking ? llmProvider : undefined,
  });

  const db = store.getDatabase();

  // Build mode-specific search function
  const searchFn = createModeSearch(mode, store, db, embedder);

  // Build gardener with mode-specific features
  const gardener = new BackgroundGardener({
    scallopStore: store,
    logger: testLogger,
    fusionProvider: (mode.enableFusion || mode.enableDreams || mode.enableReflection || mode.enableProactive)
      ? llmProvider
      : undefined,
    quietHours: { start: 2, end: 5 },
    workspace: mode.enableReflection ? `/tmp/eval-workspace-${mode.name}` : undefined,
  });

  // Ensure workspace dir exists for SOUL.md
  if (mode.enableReflection) {
    const wsDir = `/tmp/eval-workspace-${mode.name}`;
    try { fs.mkdirSync(wsDir, { recursive: true }); } catch { /* exists */ }
  }

  // Track affect state
  let affectState = createInitialAffectState();

  const allMetrics: DayMetrics[] = [];

  for (const dayScenario of scenarios) {
    const dayNum = dayScenario.day;
    const dayStart = BASE_DATE + (dayNum - 1) * DAY_MS;

    try {
      console.log(`[eval] ${mode.name} Day ${dayNum}: starting`);
      // 1. SET TIME → Day N, 9:00 AM
      vi.setSystemTime(new Date(dayStart + 9 * HOUR_MS));

      // 2. INGEST CONVERSATIONS
      for (let sIdx = 0; sIdx < dayScenario.sessions.length; sIdx++) {
        const session = dayScenario.sessions[sIdx];

        // Create session
        db.createSession(session.id);

        // Collect user messages for potential batched fact extraction
        const userMessages: string[] = [];

        for (const msg of session.messages) {
          if (msg.role === 'user') {
            // Classify affect
            const rawAffect = classifyAffect(msg.content);
            affectState = updateAffectEMA(
              affectState,
              rawAffect,
              Date.now(),
            );

            if (mode.enableFactExtraction) {
              userMessages.push(msg.content);
            } else {
              // ── OpenClaw / ScallopBot: store raw user messages ──
              await store.add({
                userId: USER_ID,
                content: msg.content,
                category: categorizeMessage(msg.content),
                importance: estimateImportance(msg.content),
                source: 'user',
                detectRelations: mode.enableFusion || mode.enableDreams,
              });
            }
          }

          // Add all messages to session for summary generation
          db.addSessionMessage(session.id, msg.role, msg.content);
        }

        // ── Mem0 pipeline: batch LLM fact extraction per session ──
        // Real Mem0 extracts facts from the last ~10 messages in a session,
        // then for each fact uses LLM to decide ADD/UPDATE/DELETE/NONE.
        // We batch all user messages per session into one extraction call.
        if (mode.enableFactExtraction && userMessages.length > 0) {
          const facts = await extractFactsWithLLM(llmProvider, userMessages.join('\n'));

          for (const fact of facts) {
            if (mode.enableLLMDedup) {
              // Search top-5 similar existing memories for this fact
              const factEmb = await embedder.embed(fact);
              const existingCandidates = db.getMemoriesByUser(USER_ID, {
                isLatest: true,
                includeAllSources: true,
              });
              const similar = existingCandidates
                .filter(m => m.embedding != null)
                .map(m => ({ memory: m, sim: cosineSimilarity(factEmb, m.embedding!) }))
                .sort((a, b) => b.sim - a.sim)
                .slice(0, 5);

              // Only call LLM for dedup if there are similar existing memories
              if (similar.length > 0 && similar[0].sim > 0.5) {
                const action = await decideMem0Action(llmProvider, fact, similar.map(s => s.memory.content));

                if (action.event === 'ADD') {
                  await store.add({
                    userId: USER_ID,
                    content: fact,
                    category: categorizeMessage(fact),
                    importance: estimateImportance(fact),
                    source: 'user',
                    detectRelations: false,
                  });
                } else if (action.event === 'UPDATE' && action.index != null && similar[action.index]) {
                  store.update(similar[action.index].memory.id, { content: fact });
                } else if (action.event === 'DELETE' && action.index != null && similar[action.index]) {
                  store.update(similar[action.index].memory.id, { content: '[DELETED]' });
                }
                // NONE = do nothing
              } else {
                // No similar memories — just add
                await store.add({
                  userId: USER_ID,
                  content: fact,
                  category: categorizeMessage(fact),
                  importance: estimateImportance(fact),
                  source: 'user',
                  detectRelations: false,
                });
              }
            } else {
              await store.add({
                userId: USER_ID,
                content: fact,
                category: categorizeMessage(fact),
                importance: estimateImportance(fact),
                source: 'user',
                detectRelations: false,
              });
            }
          }
        }

        // Add session summary (needed for reflection, gap scanner)
        const topics = extractTopics(session.messages.map(m => m.content).join(' '));
        const messageCount = session.messages.length;
        db.addSessionSummary({
          sessionId: session.id,
          userId: USER_ID,
          summary: `Day ${dayNum}: ${dayScenario.theme}. ${session.messages.filter(m => m.role === 'user').map(m => m.content).join(' ')}`,
          topics,
          messageCount,
          durationMs: 30 * 60 * 1000, // 30 min simulated
          embedding: null,
        });

        // Update behavioral patterns with affect
        try {
          const smoothed = getSmoothedAffect(affectState);
          const profileManager = store.getProfileManager();
          profileManager.updateBehavioralPatterns(USER_ID, {
            affectState: { valence: smoothed.valence, arousal: smoothed.arousal },
            smoothedAffect: smoothed,
          });
        } catch { /* ignore */ }

        // Advance time between sessions
        vi.advanceTimersByTime(30 * 60 * 1000);
      }

      console.log(`[eval] ${mode.name} Day ${dayNum}: ingestion done`);
      // 3. RUN LIGHT TICKS (3x spread across the day)
      if (mode.enableDecay) {
        vi.setSystemTime(new Date(dayStart + 13 * HOUR_MS));
        gardener.lightTick();
        vi.setSystemTime(new Date(dayStart + 17 * HOUR_MS));
        gardener.lightTick();
        vi.setSystemTime(new Date(dayStart + 21 * HOUR_MS));
        gardener.lightTick();
      }

      // 4. RUN DEEP TICK (evening)
      if (mode.enableFusion || mode.enableProactive) {
        console.log(`[eval] ${mode.name} Day ${dayNum}: deepTick starting`);
        vi.setSystemTime(new Date(dayStart + 18 * HOUR_MS));
        await gardener.deepTick();
        console.log(`[eval] ${mode.name} Day ${dayNum}: deepTick done`);
      }

      // 5. RUN SLEEP TICK (2 AM quiet hours — next day)
      if (mode.enableDreams || mode.enableReflection) {
        console.log(`[eval] ${mode.name} Day ${dayNum}: sleepTick starting`);
        vi.setSystemTime(new Date(dayStart + 26 * HOUR_MS)); // 2 AM next day
        await gardener.sleepTick();
        console.log(`[eval] ${mode.name} Day ${dayNum}: sleepTick done`);
      }

      // 6. COLLECT METRICS
      // Reset to day end for consistent measurement
      vi.setSystemTime(new Date(dayStart + 23 * HOUR_MS));

      // Read SOUL content if workspace exists
      let soulContent: string | null = null;
      if (mode.enableReflection) {
        const soulPath = `/tmp/eval-workspace-${mode.name}/SOUL.md`;
        try { soulContent = fs.readFileSync(soulPath, 'utf-8'); } catch { /* not created yet */ }
      }

      // Get detected emotion from smoothed affect state
      const smoothedForMetrics = getSmoothedAffect(affectState);
      const detectedEmotion: EmotionLabel = smoothedForMetrics.emotion;

      const applicableQueries = getQueriesForDay(dayNum);
      const metrics = await collectDayMetrics(
        db,
        store,
        searchFn,
        applicableQueries,
        llmProvider.callLog,
        llmProvider.callCount,
        dayNum,
        soulContent,
        detectedEmotion,
        dayScenario.expectedEmotion,
      );

      allMetrics.push(metrics);
    } catch (err) {
      // Per-day error handling: log and push zeroed-out metrics so the run continues
      console.error(`[eval] ${mode.name} Day ${dayNum} failed:`, err);
      allMetrics.push({
        day: dayNum,
        totalMemories: 0,
        activeCount: 0,
        dormantCount: 0,
        archivedCount: 0,
        precision5: 0,
        recall: 0,
        mrr: 0,
        fusionCount: 0,
        remDiscoveries: 0,
        relationsCount: 0,
        soulWords: 0,
        gapSignals: 0,
        trustScore: 0,
        llmCalls: llmProvider.callCount,
        detectedEmotion: 'neutral',
        expectedEmotion: dayScenario.expectedEmotion,
      });
    }
  }

  // Cleanup
  store.close();
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.unlinkSync(dbPath + suffix);
    }
  } catch { /* ignore */ }

  // Cleanup workspace
  if (mode.enableReflection) {
    try { fs.rmSync(`/tmp/eval-workspace-${mode.name}`, { recursive: true }); } catch { /* ignore */ }
  }

  return allMetrics;
}

// ============ Helpers ============

/**
 * Simple rule-based message categorization.
 */
function categorizeMessage(content: string): 'preference' | 'fact' | 'event' | 'relationship' | 'insight' {
  const lower = content.toLowerCase();
  if (lower.includes('favorite') || lower.includes('prefer') || lower.includes('love') || lower.includes('hobby')) {
    return 'preference';
  }
  if (lower.includes('team') || lower.includes('alice') || lower.includes('bob') || lower.includes('carol') || lower.includes('colleague')) {
    return 'relationship';
  }
  if (lower.includes('went') || lower.includes('did') || lower.includes('happened') || lower.includes('launched')
    || lower.includes('tried') || lower.includes('started') || lower.includes('morning')) {
    return 'event';
  }
  return 'fact';
}

/**
 * Simple rule-based importance estimation (1-10 scale).
 */
function estimateImportance(content: string): number {
  const lower = content.toLowerCase();
  let score = 5;
  // Identity/preference facts need importance >= 8 for decay protection
  if (lower.includes('favorite') || lower.includes('i am') || lower.includes("i'm") || lower.includes('my name')) score += 3;
  // Goals
  if (lower.includes('goal') || lower.includes('signed up') || lower.includes('want to')) score += 2;
  // Project milestones
  if (lower.includes('deadline') || lower.includes('launched') || lower.includes('signed up')) score += 2;
  // Temporal specifics
  if (/\b(february|march|april|feb|5k)\b/i.test(content)) score += 1;
  // People mentions
  if (lower.includes('alice') || lower.includes('bob') || lower.includes('carol')) score += 1;
  // Technical decisions
  if (lower.includes('postgresql') || lower.includes('chose') || lower.includes('decided') || lower.includes('rust') || lower.includes('rewrite')) score += 1;
  return Math.min(10, score);
}

/**
 * Extract topic keywords from text.
 */
function extractTopics(text: string): string[] {
  const topicWords = [
    'atlas', 'project', 'deadline', 'database', 'postgresql', 'hiking', 'cooking',
    'running', 'sushi', 'travel', 'japan', 'kyoto', 'rust', 'team', 'alice', 'bob',
    'launch', 'auth', 'microservices', 'sourdough', 'pasta', '5k', 'race',
    'carol', 'ramen', 'tokyo', 'osaka', 'temple', 'monitoring', '10k', 'borrow',
  ];
  const lower = text.toLowerCase();
  return topicWords.filter(t => lower.includes(t));
}

// ============ Mem0 LLM Pipeline ============

/**
 * Extract structured facts from user messages using the LLM.
 * Mirrors Mem0's FACT_RETRIEVAL_PROMPT — the LLM identifies discrete personal
 * facts, preferences, and biographical details from conversational text.
 * Accepts a session's worth of messages batched together.
 */
async function extractFactsWithLLM(provider: LLMProvider, messages: string): Promise<string[]> {
  const response = await provider.complete({
    system: [
      'You are a Personal Information Organizer, specialized in accurately storing facts, user memories, and preferences.',
      'Extract discrete personal facts from the user messages below. Each fact should be a short, self-contained statement.',
      'Categories: personal preferences, biographical details, plans/intentions, activity preferences, professional details.',
      'Respond with a JSON object: {"facts": ["fact1", "fact2", ...]}',
      'If no personal facts can be extracted, return {"facts": []}.',
      'Do NOT include conversational filler or questions — only factual statements about the user.',
      'Preserve specific details: names, dates, places, numbers, and technical terms.',
    ].join('\n'),
    messages: [{ role: 'user', content: messages }],
    temperature: 0,
    maxTokens: 500,
  });

  const text = extractResponseText(response.content);
  try {
    // Try to parse JSON from response (handle markdown code blocks)
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed.facts)) {
      return parsed.facts.filter((f: unknown) => typeof f === 'string' && f.length > 0);
    }
  } catch {
    // Fallback: if LLM didn't return valid JSON, store the raw message as one fact
  }
  return [messages];
}

/**
 * Mem0's memory action decision. Given a new fact and the top-5 similar existing
 * memories, the LLM decides: ADD (new info), UPDATE (modify existing), DELETE
 * (contradicts existing), or NONE (already exists / irrelevant).
 */
interface Mem0Action {
  event: 'ADD' | 'UPDATE' | 'DELETE' | 'NONE';
  index?: number; // index into the existing memories array
}

async function decideMem0Action(
  provider: LLMProvider,
  newFact: string,
  existingMemories: string[],
): Promise<Mem0Action> {
  if (existingMemories.length === 0) {
    return { event: 'ADD' };
  }

  const memoriesList = existingMemories
    .map((m, i) => `${i}: ${m}`)
    .join('\n');

  const response = await provider.complete({
    system: [
      'You are a smart memory manager. You control the memory of a system.',
      'You can perform four operations:',
      '1. ADD: The new fact is genuinely new information not covered by existing memories.',
      '2. UPDATE: The new fact modifies or refines an existing memory. Provide the index of the memory to update.',
      '3. DELETE: The new fact contradicts an existing memory. Provide the index of the memory to delete.',
      '4. NONE: The new fact is already captured by existing memories. No action needed.',
      '',
      'Respond with a JSON object: {"event": "ADD|UPDATE|DELETE|NONE", "index": <number or null>}',
    ].join('\n'),
    messages: [{
      role: 'user',
      content: `New fact: ${newFact}\n\nExisting memories:\n${memoriesList}`,
    }],
    temperature: 0,
    maxTokens: 100,
  });

  const text = extractResponseText(response.content);
  try {
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const event = parsed.event?.toUpperCase();
    if (['ADD', 'UPDATE', 'DELETE', 'NONE'].includes(event)) {
      return {
        event,
        index: typeof parsed.index === 'number' ? parsed.index : undefined,
      };
    }
  } catch {
    // Fallback: if LLM didn't return valid JSON, default to ADD
  }
  return { event: 'ADD' };
}

/**
 * Extract text from LLM response content blocks.
 */
function extractResponseText(content: ContentBlock[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('');
}
