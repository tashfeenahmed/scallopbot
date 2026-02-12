/**
 * LoCoMo Benchmark Evaluation Runner
 *
 * Runs the LoCoMo benchmark (Maharana et al., ACL 2024) — long-term conversational
 * memory evaluation with multi-session dialogues and 5 QA categories:
 *   1. Single-hop   2. Temporal   3. Open-domain   4. Multi-hop   5. Adversarial
 *
 * Half benchmark: 5 of 10 conversations (1,049 QA items), preserving category
 * proportions to within 0.3%.
 *
 * Three modes: OpenClaw, Mem0, ScallopBot — same as the EmoBench/30-day eval.
 * Uses Moonshot kimi-k2.5 for LLM calls.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { vi } from 'vitest';
import dotenv from 'dotenv';
import { ScallopMemoryStore } from '../memory/scallop-store.js';
import { BackgroundGardener } from '../memory/memory.js';
import { testLogger } from '../e2e/helpers.js';
import { cosineSimilarity } from '../memory/embeddings.js';
import type { LLMProvider, ContentBlock } from '../providers/types.js';

import {
  createTrackedProvider,
  createEvalProviders,
  categorizeMessage,
  estimateImportance,
  extractFactsWithLLM,
  decideMem0Action,
  type TrackedProvider,
} from './eval-runner.js';
import {
  createModeSearch,
  type EvalModeConfig,
  OPENCLAW_MODE,
  MEM0_MODE,
  SCALLOPBOT_MODE,
  ALL_MODES,
} from './modes.js';
import { mapConcurrent } from './emobench-eval.js';

// Load .env from project root so API keys are available in vitest
dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });

// ============ Constants ============

const USER_ID = 'default';
const SELECTED_IDS = new Set(['conv-26', 'conv-41', 'conv-42', 'conv-44', 'conv-48']);
const CATEGORY_NAMES: Record<number, string> = {
  1: 'Single-hop',
  2: 'Temporal',
  3: 'Open-domain',
  4: 'Multi-hop',
  5: 'Adversarial',
};

// ============ Types ============

export interface LoCoMoTurn {
  speaker: string;
  dia_id: string;
  text: string;
}

export interface LoCoMoSession {
  index: number;
  dateTime: Date;
  turns: LoCoMoTurn[];
}

export interface LoCoMoQA {
  question: string;
  answer: string;
  evidence: string[];
  category: number;
}

export interface LoCoMoConversation {
  sampleId: string;
  sessions: LoCoMoSession[];
  qa: LoCoMoQA[];
}

export interface LoCoMoModeResult {
  mode: string;
  label: string;
  overallF1: number;
  overallEM: number;
  f1ByCategory: Record<string, number>;
  emByCategory: Record<string, number>;
  perConversation: Array<{
    sampleId: string;
    f1: number;
    em: number;
    qaCount: number;
  }>;
  llmCalls: number;
  qaCount: number;
}

export interface LoCoMoResults {
  timestamp: string;
  model: string;
  conversations: number;
  totalQA: number;
  modes: LoCoMoModeResult[];
}

// ============ Data Loading ============

/**
 * Parse LoCoMo datetime strings like "1:56 pm on 8 May, 2023" → Date
 */
export function parseLoCoMoDateTime(s: string): Date {
  // Format: "H:MM am/pm on D Month, YYYY"
  const match = s.match(
    /^(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+(\w+),?\s*(\d{4})$/i,
  );
  if (!match) {
    return new Date(s); // fallback
  }

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const ampm = match[3].toLowerCase();
  const day = parseInt(match[4], 10);
  const monthStr = match[5];
  const year = parseInt(match[6], 10);

  if (ampm === 'pm' && hours !== 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;

  const monthNames: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };
  const month = monthNames[monthStr.toLowerCase()] ?? 0;

  return new Date(year, month, day, hours, minutes);
}

/**
 * Load and parse LoCoMo conversations from the JSON file.
 * Filters to selected conversation IDs if provided.
 */
export function loadLoCoMoData(
  filePath: string,
  selectedIds?: Set<string>,
): LoCoMoConversation[] {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Array<Record<string, unknown>>;
  const ids = selectedIds ?? SELECTED_IDS;

  return raw
    .filter(conv => ids.has(conv.sample_id as string))
    .map(conv => {
      const conversation = conv.conversation as Record<string, unknown>;

      // Extract sessions: keys matching /^session_\d+$/ (not _date_time)
      const sessionKeys = Object.keys(conversation)
        .filter(k => /^session_\d+$/.test(k))
        .sort((a, b) => {
          const numA = parseInt(a.replace('session_', ''), 10);
          const numB = parseInt(b.replace('session_', ''), 10);
          return numA - numB;
        });

      const sessions: LoCoMoSession[] = sessionKeys.map((key, idx) => {
        const sessionNum = parseInt(key.replace('session_', ''), 10);
        const dateTimeKey = `${key}_date_time`;
        const dateTimeStr = conversation[dateTimeKey] as string | undefined;
        const dateTime = dateTimeStr ? parseLoCoMoDateTime(dateTimeStr) : new Date(2023, 0, 1 + idx);

        const rawTurns = conversation[key] as Array<Record<string, unknown>>;
        // Keep all turns that have text (including multimodal turns with text)
        const turns: LoCoMoTurn[] = rawTurns
          .filter(t => typeof t.text === 'string' && (t.text as string).length > 0)
          .map(t => ({
            speaker: t.speaker as string,
            dia_id: t.dia_id as string,
            text: t.text as string,
          }));

        return { index: sessionNum, dateTime, turns };
      });

      const qa = (conv.qa as Array<Record<string, unknown>>).map(q => ({
        question: q.question as string,
        // Category 5 (adversarial) has null answers — unanswerable by design
        answer: (q.answer as string | null) ?? '',
        evidence: (q.evidence as string[] | null) ?? [],
        category: q.category as number,
      }));

      return {
        sampleId: conv.sample_id as string,
        sessions,
        qa,
      };
    });
}

// ============ F1 / EM Scoring ============

/**
 * Minimal Porter stemmer for F1 scoring — handles common English suffixes.
 * No new dependency needed; covers ~80% of cases.
 */
function porterStem(word: string): string {
  if (word.length <= 2) return word;

  // Step: -ness, -tion, -ly
  if (word.endsWith('ness')) word = word.slice(0, -4);
  else if (word.endsWith('tion')) word = word.slice(0, -4);
  else if (word.endsWith('ly')) word = word.slice(0, -2);

  // Step: -ing, -ed (with doubled consonant reduction: running → run)
  if (word.endsWith('ing') && word.length > 5) {
    word = word.slice(0, -3);
    if (/(.)\1$/.test(word) && !/[lsz]$/.test(word)) word = word.slice(0, -1);
  } else if (word.endsWith('ed') && word.length > 4) {
    word = word.slice(0, -2);
    if (/(.)\1$/.test(word) && !/[lsz]$/.test(word)) word = word.slice(0, -1);
  }

  // Step: -es, -s
  if (word.endsWith('ies') && word.length > 4) word = word.slice(0, -3) + 'y';
  else if (word.endsWith('es') && word.length > 4) word = word.slice(0, -2);
  else if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) word = word.slice(0, -1);

  return word;
}

const ARTICLES = new Set(['a', 'an', 'the']);

/**
 * Normalize text for F1/EM comparison:
 * lowercase → remove articles → remove punctuation → minimal Porter stem → tokenize
 */
export function normalizeAnswer(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0 && !ARTICLES.has(w))
    .map(porterStem);
}

/**
 * Compute token-level F1 between prediction and label.
 */
export function computeF1(predicted: string, label: string): number {
  const predTokens = normalizeAnswer(predicted);
  const labelTokens = normalizeAnswer(label);

  if (predTokens.length === 0 && labelTokens.length === 0) return 1.0;
  if (predTokens.length === 0 || labelTokens.length === 0) return 0.0;

  const labelSet = new Set(labelTokens);
  const common = predTokens.filter(t => labelSet.has(t)).length;

  if (common === 0) return 0.0;

  const precision = common / predTokens.length;
  const recall = common / labelTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Exact match: normalized token sets are identical.
 */
export function computeEM(predicted: string, label: string): number {
  const predTokens = normalizeAnswer(predicted);
  const labelTokens = normalizeAnswer(label);

  if (predTokens.length !== labelTokens.length) return 0;
  const predStr = predTokens.join(' ');
  const labelStr = labelTokens.join(' ');
  return predStr === labelStr ? 1 : 0;
}

/**
 * For adversarial questions (category 5), the label is empty/null meaning
 * the question is unanswerable. The model should respond with "UNKNOWN" or
 * similar refusal. Score 1.0 if predicted indicates unanswerable, 0.0 otherwise.
 */
const UNANSWERABLE_PATTERNS = /\b(unknown|unanswer|not (mentioned|provided|in the context|available|stated|found)|cannot (be determined|determine|answer)|no (information|context|evidence|data))\b/i;

export function scoreAdversarial(predicted: string): number {
  return UNANSWERABLE_PATTERNS.test(predicted) ? 1.0 : 0.0;
}

// ============ QA Answering ============

function extractResponseText(content: ContentBlock[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('');
}

interface QAResult {
  question: string;
  predicted: string;
  label: string;
  category: number;
  f1: number;
  em: number;
}

/**
 * Answer a single QA item using retrieved memories as context.
 */
async function answerQA(
  provider: LLMProvider,
  question: string,
  contextMemories: string[],
  category?: number,
): Promise<string> {
  const contextBlock = contextMemories
    .map((m, i) => `[${i + 1}] ${m}`)
    .join('\n');

  // Open-domain (category 3): allow parametric knowledge alongside context
  const systemPrompt = category === 3
    ? [
        'You are answering questions based on retrieved conversation memories and your general knowledge.',
        'Answer concisely using the provided context and your general knowledge. If the answer is not in the context and you don\'t know, say "UNKNOWN".',
        '',
        'Context:',
        contextBlock,
      ].join('\n')
    : [
        'You are answering questions based on retrieved conversation memories.',
        'Answer concisely using ONLY the provided context. If the answer is not in the context, say "UNKNOWN".',
        '',
        'Context:',
        contextBlock,
      ].join('\n');

  const response = await provider.complete({
    system: systemPrompt,
    messages: [{ role: 'user', content: `Question: ${question}` }],
    temperature: 0,
    maxTokens: 100,
  });

  return extractResponseText(response.content).trim();
}

// ============ Running Progress Table ============

/**
 * Print a running comparison table after each conversation completes within a mode.
 */
function printRunningTable(
  modeLabel: string,
  perConv: Array<{ sampleId: string; f1: number; em: number; qaCount: number }>,
  allResults: QAResult[],
): void {
  const runF1 = allResults.reduce((s, r) => s + r.f1, 0) / allResults.length;
  const runEM = allResults.reduce((s, r) => s + r.em, 0) / allResults.length;

  // Per-category running scores
  const catScores: string[] = [];
  for (const cat of [1, 2, 3, 4, 5]) {
    const catResults = allResults.filter(r => r.category === cat);
    if (catResults.length > 0) {
      const name = CATEGORY_NAMES[cat];
      const f1 = catResults.reduce((s, r) => s + r.f1, 0) / catResults.length;
      catScores.push(`${name}=${f1.toFixed(3)}`);
    }
  }

  const convLines = perConv
    .map(c => `  ${c.sampleId}: F1=${c.f1.toFixed(3)} EM=${c.em.toFixed(3)} (${c.qaCount} QA)`)
    .join('\n');

  console.log(
    `\n┌─── ${modeLabel} Progress (${perConv.length}/5 convs, ${allResults.length} QA) ───\n` +
    `│ Running Overall: F1=${runF1.toFixed(3)}  EM=${runEM.toFixed(3)}\n` +
    `│ By Category: ${catScores.join('  ')}\n` +
    `│ Per Conversation:\n` +
    convLines.split('\n').map(l => `│${l}`).join('\n') + '\n' +
    `└${'─'.repeat(60)}`,
  );
}

// ============ Per-Mode Evaluation ============

/**
 * Run the LoCoMo evaluation for a single mode across all conversations.
 */
async function evaluateMode(
  mode: EvalModeConfig,
  conversations: LoCoMoConversation[],
): Promise<LoCoMoModeResult> {
  const { embedder, llmProvider } = createEvalProviders();

  const perConversation: LoCoMoModeResult['perConversation'] = [];
  const allResults: QAResult[] = [];

  for (const conv of conversations) {
    console.log(`[locomo] ${mode.name}/${conv.sampleId}: starting (${conv.sessions.length} sessions, ${conv.qa.length} QA)`);

    // Isolated DB per mode+conversation
    const dbPath = `/tmp/locomo-eval-${mode.name}-${conv.sampleId}-${Date.now()}.db`;

    const store = new ScallopMemoryStore({
      dbPath,
      logger: testLogger,
      embedder,
      decayConfig: mode.enableDecay ? mode.decayOverrides : { baseDecayRate: 1.0 },
      rerankProvider: mode.enableReranking ? llmProvider : undefined,
    });

    const db = store.getDatabase();
    const searchFn = createModeSearch(mode, store, db, embedder);

    const gardener = new BackgroundGardener({
      scallopStore: store,
      logger: testLogger,
      fusionProvider: (mode.enableFusion || mode.enableDreams || mode.enableReflection)
        ? llmProvider
        : undefined,
      quietHours: { start: 2, end: 5 },
      disableArchival: true, // Eval batch-ingests without retrieval, so accessCount=0 → utility=0 → everything gets archived
    });

    // Track which calendar day we're on for cognitive ticks
    let lastCalendarDay = -1;

    // ── Ingest sessions chronologically ──
    for (let sIdx = 0; sIdx < conv.sessions.length; sIdx++) {
      const session = conv.sessions[sIdx];
      vi.setSystemTime(session.dateTime);

      const currentDay = session.dateTime.getDate();
      const dayChanged = currentDay !== lastCalendarDay && lastCalendarDay !== -1;

      // Run cognitive ticks when day changes (for ScallopBot)
      if (dayChanged) {
        if (mode.enableDecay) {
          gardener.lightTick();
        }
        if (mode.enableFusion) {
          await gardener.deepTick();
        }
      }

      // Run overnight ticks between day boundaries
      if (dayChanged && (mode.enableDreams || mode.enableReflection)) {
        // Set to 3 AM for sleep tick (quiet hours)
        const sleepTime = new Date(session.dateTime);
        sleepTime.setHours(3, 0, 0, 0);
        vi.setSystemTime(sleepTime);
        await gardener.sleepTick();
        vi.setSystemTime(session.dateTime);
      }

      lastCalendarDay = currentDay;

      if (mode.enableFactExtraction) {
        // ── Mem0 pipeline: batch extract facts from all turns in session ──
        const allTexts = session.turns.map(t => `${t.speaker}: ${t.text}`).join('\n');
        if (allTexts.length > 0) {
          const facts = await extractFactsWithLLM(llmProvider, allTexts);

          for (const fact of facts) {
            if (mode.enableLLMDedup) {
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
      } else {
        // ── OpenClaw / ScallopBot: store each turn as raw text ──
        const sessionDateLabel = session.dateTime.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        for (const turn of session.turns) {
          const content = `[${sessionDateLabel}] ${turn.speaker}: ${turn.text}`;
          await store.add({
            userId: USER_ID,
            content,
            category: categorizeMessage(content),
            importance: estimateImportance(content),
            source: 'user',
            detectRelations: mode.enableFusion || mode.enableDreams,
          });
        }
      }

      console.log(`[locomo] ${mode.name}/${conv.sampleId}: ingested session ${sIdx + 1}/${conv.sessions.length}`);
    }

    // Final cognitive ticks after all sessions
    if (mode.enableDecay) {
      gardener.lightTick();
    }
    if (mode.enableFusion) {
      await gardener.deepTick();
    }
    if (mode.enableDreams || mode.enableReflection) {
      const lastDate = conv.sessions[conv.sessions.length - 1].dateTime;
      const sleepTime = new Date(lastDate);
      sleepTime.setDate(sleepTime.getDate() + 1);
      sleepTime.setHours(3, 0, 0, 0);
      vi.setSystemTime(sleepTime);
      await gardener.sleepTick();
    }

    // ── Instrumentation: Count memories stored ──
    const allMemories = db.getMemoriesByUser(USER_ID, { includeAllSources: true });
    const latestMemories = allMemories.filter(m => m.isLatest);
    const regularMemories = allMemories.filter(m => m.memoryType === 'regular');
    const derivedMemories = allMemories.filter(m => m.memoryType === 'derived');
    const supersededMemories = allMemories.filter(m => m.memoryType === 'superseded');
    const withEmbeddings = allMemories.filter(m => m.embedding != null);
    console.log(
      `[locomo] ${mode.name}/${conv.sampleId}: MEMORY CENSUS — ` +
      `Total=${allMemories.length} (isLatest=${latestMemories.length}), ` +
      `Regular=${regularMemories.length}, Derived=${derivedMemories.length}, ` +
      `Superseded=${supersededMemories.length}, WithEmbeddings=${withEmbeddings.length}`
    );

    console.log(`[locomo] ${mode.name}/${conv.sampleId}: answering ${conv.qa.length} QA items`);

    // ── Answer QA items (parallelized) ──
    const qaResults = await mapConcurrent(
      conv.qa,
      async (qa) => {
        try {
          // Use higher top-K for non-adversarial to help multi-hop/temporal
          const retrievalLimit = qa.category === 5 ? 5 : 8;
          const memories = await searchFn(qa.question, retrievalLimit);
          // Score-gate: only pass memories scoring >= 0.25 to the answerer
          const gated = memories.filter(m => m.score >= 0.25);
          const contextTexts = gated.map(m => m.memory.content);
          const predicted = await answerQA(llmProvider, qa.question, contextTexts, qa.category);
          // Adversarial (cat 5): label is empty; score whether model correctly refuses
          let f1: number, em: number;
          if (qa.category === 5) {
            const score = scoreAdversarial(predicted);
            f1 = score;
            em = score;
          } else {
            f1 = computeF1(predicted, qa.answer);
            em = computeEM(predicted, qa.answer);
          }
          return { question: qa.question, predicted, label: qa.answer, category: qa.category, f1, em };
        } catch (err) {
          console.error(`[locomo] QA error: ${(err as Error).message}`);
          return { question: qa.question, predicted: 'ERROR', label: qa.answer, category: qa.category, f1: 0, em: 0 };
        }
      },
      10,
    );

    allResults.push(...qaResults);

    const convF1 = qaResults.reduce((s, r) => s + r.f1, 0) / qaResults.length;
    const convEM = qaResults.reduce((s, r) => s + r.em, 0) / qaResults.length;
    perConversation.push({ sampleId: conv.sampleId, f1: convF1, em: convEM, qaCount: qaResults.length });

    console.log(`[locomo] ${mode.name}/${conv.sampleId}: F1=${convF1.toFixed(3)}, EM=${convEM.toFixed(3)}`);

    // Print running comparison table after each conversation
    printRunningTable(mode.label, perConversation, allResults);

    // Cleanup
    store.close();
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        fs.unlinkSync(dbPath + suffix);
      }
    } catch { /* ignore */ }
  }

  // Aggregate scores
  const overallF1 = allResults.reduce((s, r) => s + r.f1, 0) / allResults.length;
  const overallEM = allResults.reduce((s, r) => s + r.em, 0) / allResults.length;

  // Per-category scores
  const f1ByCategory: Record<string, number> = {};
  const emByCategory: Record<string, number> = {};
  for (const cat of [1, 2, 3, 4, 5]) {
    const catResults = allResults.filter(r => r.category === cat);
    if (catResults.length > 0) {
      const name = CATEGORY_NAMES[cat];
      f1ByCategory[name] = catResults.reduce((s, r) => s + r.f1, 0) / catResults.length;
      emByCategory[name] = catResults.reduce((s, r) => s + r.em, 0) / catResults.length;
    }
  }

  return {
    mode: mode.name,
    label: mode.label,
    overallF1,
    overallEM,
    f1ByCategory,
    emByCategory,
    perConversation,
    llmCalls: llmProvider.callCount,
    qaCount: allResults.length,
  };
}

// ============ Report ============

function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (align === 'right') return s.padStart(width);
  return s.padEnd(width);
}

function fmt(n: number): string {
  return n.toFixed(2);
}

function buildTable(
  headers: string[],
  rows: string[][],
  colWidths: number[],
): string {
  const sep = '+-' + colWidths.map(w => '-'.repeat(w)).join('-+-') + '-+';
  const headerLine =
    '| ' + headers.map((h, i) => pad(h, colWidths[i])).join(' | ') + ' |';

  const lines = [sep, headerLine, sep];
  for (const row of rows) {
    lines.push(
      '| ' +
        row
          .map((c, i) => pad(c, colWidths[i], i === 0 ? 'left' : 'right'))
          .join(' | ') +
        ' |',
    );
  }
  lines.push(sep);
  return lines.join('\n');
}

export function printLoCoMoReport(results: LoCoMoResults): void {
  const banner = [
    '',
    '='.repeat(64),
    `    LoCoMo QA Results (${results.conversations} conversations, Moonshot ${results.model})`,
    '='.repeat(64),
    '',
  ].join('\n');

  // Overall table
  const overallRows = results.modes.map(m => [
    m.label,
    fmt(m.overallF1),
    fmt(m.overallEM),
    m.llmCalls.toString(),
  ]);
  const overallTable = buildTable(
    ['Mode', 'F1', 'EM', 'LLM Calls'],
    overallRows,
    [12, 6, 6, 10],
  );

  // F1 by Category table
  const categories = ['Single-hop', 'Temporal', 'Open-domain', 'Multi-hop', 'Adversarial'];
  const f1Rows = categories.map(cat => [
    cat,
    ...results.modes.map(m => fmt(m.f1ByCategory[cat] ?? 0)),
  ]);
  const f1Headers = ['Category', ...results.modes.map(m => m.label)];
  const f1Widths = [12, ...results.modes.map(m => Math.max(m.label.length, 6))];
  const f1Table = buildTable(f1Headers, f1Rows, f1Widths);

  // Per-conversation table
  const convRows: string[][] = [];
  for (const mode of results.modes) {
    for (const conv of mode.perConversation) {
      convRows.push([mode.label, conv.sampleId, fmt(conv.f1), fmt(conv.em), conv.qaCount.toString()]);
    }
  }
  const convTable = buildTable(
    ['Mode', 'Conv', 'F1', 'EM', 'QA'],
    convRows,
    [12, 8, 6, 6, 5],
  );

  const report = [
    banner,
    'Overall:',
    overallTable,
    '',
    'F1 by Category:',
    f1Table,
    '',
    'Per-Conversation Breakdown:',
    convTable,
    '',
  ].join('\n');

  console.log(report);
}

// ============ Main Runner ============

export async function runLoCoMo(options?: {
  dataPath?: string;
  outputPath?: string;
  selectedIds?: Set<string>;
  modes?: EvalModeConfig[];
}): Promise<LoCoMoResults> {
  const dataPath = options?.dataPath ?? path.resolve(process.cwd(), 'data/locomo/locomo10.json');
  const outputPath = options?.outputPath ?? path.resolve(process.cwd(), 'results/locomo-results.json');
  const selectedIds = options?.selectedIds ?? SELECTED_IDS;
  const modes = options?.modes ?? ALL_MODES;

  const conversations = loadLoCoMoData(dataPath, selectedIds);
  const totalQA = conversations.reduce((s, c) => s + c.qa.length, 0);
  console.log(`Loaded ${conversations.length} conversations, ${totalQA} QA items`);

  const modeResults: LoCoMoModeResult[] = [];

  for (const mode of modes) {
    console.log(`\n${'='.repeat(40)}\n[locomo] Starting mode: ${mode.label}\n${'='.repeat(40)}`);
    const result = await evaluateMode(mode, conversations);
    modeResults.push(result);
    console.log(`[locomo] ${mode.label} done: F1=${result.overallF1.toFixed(3)}, EM=${result.overallEM.toFixed(3)}, LLM calls=${result.llmCalls}`);

    // Print cross-mode comparison after each mode completes
    if (modeResults.length > 0) {
      printLoCoMoReport({
        timestamp: new Date().toISOString(),
        model: 'kimi-k2.5',
        conversations: conversations.length,
        totalQA,
        modes: modeResults,
      });
    }
  }

  const results: LoCoMoResults = {
    timestamp: new Date().toISOString(),
    model: 'kimi-k2.5',
    conversations: conversations.length,
    totalQA,
    modes: modeResults,
  };

  printLoCoMoReport(results);

  // Write results JSON
  const resultsDir = path.dirname(outputPath);
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`Results written to: ${outputPath}`);

  return results;
}
