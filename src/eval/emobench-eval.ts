/**
 * EmoBench Evaluation Runner
 *
 * Runs the EmoBench benchmark (Sabour et al., ACL 2024) — 400 multiple-choice
 * questions testing Emotional Understanding (EU) and Emotional Application (EA).
 *
 * Three conditions:
 * 1. Baseline (OpenClaw) — bare LLM, no affect enrichment
 * 2. ScallopBot — LLM + USER AFFECT CONTEXT block from classifyAffect()
 * 3. AFINN-165 Direct — lexicon classifier vs ground-truth valence
 *
 * Uses Moonshot kimi-k2.5 for LLM conditions.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import dotenv from 'dotenv';
import { classifyAffect } from '../memory/affect.js';
import { MoonshotProvider } from '../providers/moonshot.js';
import type { CompletionRequest, ContentBlock } from '../providers/types.js';

// Load .env from project root so API keys are available in vitest
dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });

// ============ Types ============

interface EUItem {
  qid: string;
  language: string;
  coarse_category: string;
  finegrained_category: string;
  scenario: string;
  subject: string;
  emotion_choices: string[];
  emotion_label: string;
  cause_choices: string[];
  cause_label: string;
}

interface EAItem {
  qid: string;
  language: string;
  category: string;
  'question type': string;
  scenario: string;
  subject: string;
  choices: string[];
  label: string;
}

interface EAResult {
  qid: string;
  category: string;
  correct: boolean;
  predicted: string;
  label: string;
}

interface EUResult {
  qid: string;
  category: string;
  emoCorrect: boolean;
  causeCorrect: boolean;
  bothCorrect: boolean;
  predictedEmo: string;
  predictedCause: string;
  labelEmo: string;
  labelCause: string;
}

interface AFINNResult {
  qid: string;
  emotionLabel: string;
  detectedValence: number;
  detectedArousal: number;
  detectedEmotion: string;
  expectedValenceSign: 'positive' | 'negative' | 'neutral';
  valenceCorrect: boolean;
  quadrantCorrect: boolean;
}

export interface EmoBenchResults {
  timestamp: string;
  model: string;
  ea: {
    baseline: { overall: number; byCategory: Record<string, number> };
    scallopbot: { overall: number; byCategory: Record<string, number> };
  };
  eu: {
    baseline: { overall: number; byCategory: Record<string, number> };
    scallopbot: { overall: number; byCategory: Record<string, number> };
  };
  afinn: {
    valenceAccuracy: number;
    quadrantAccuracy: number;
    totalItems: number;
  };
}

// ============ Data Loading ============

function loadJSONL<T>(filePath: string): T[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as T);
}

export function loadEmoBenchData(dataDir: string): { eu: EUItem[]; ea: EAItem[] } {
  const eu = loadJSONL<EUItem>(path.join(dataDir, 'EU.jsonl')).filter(
    item => item.language === 'en',
  );
  const ea = loadJSONL<EAItem>(path.join(dataDir, 'EA.jsonl')).filter(
    item => item.language === 'en',
  );
  return { eu, ea };
}

// ============ Prompt Formatting ============

function letterEncode(choices: string[]): string {
  return choices
    .map((c, i) => `${String.fromCharCode(65 + i)}. ${c}`)
    .join('\n');
}

const SYSTEM_PROMPT =
  `# Instructions\n\n` +
  `In this task, you are presented with a scenario, a question, and multiple choices. \n` +
  `Carefully analyze the scenario and take the perspective of the individual involved.\n` +
  `Then, select the option that best reflects their perspective or emotional response.\n\n` +
  `# Output\n` +
  `Provide only one single correct answer to this question. ` +
  `Do not provide any additional information or explanations. ` +
  `The response should be in the following JSON format:\n`;

const EA_RESPONSE_FMT = `{\n  "answer": "<Respond with the corresponding letter numbering>"\n}`;

const EU_RESPONSE_FMT =
  `{\n  "answer_q1": "<Respond to the Question 1 with the corresponding letter numbering>",\n` +
  `  "answer_q2": "<Respond to the Question 2 with the corresponding letter numbering>"\n}`;

function buildEAPrompt(item: EAItem): string {
  const qType = item['question type'].toLowerCase();
  return (
    `## Scenario\n${item.scenario}\n\n` +
    `## Question \nIn this scenario, what is the most effective ${qType} for ${item.subject}?\n\n` +
    `## Choices\n${letterEncode(item.choices)}`
  );
}

function buildEUPrompt(item: EUItem): string {
  return (
    `## Scenario\n${item.scenario}\n\n` +
    `## Question 1\nWhat emotion(s) would ${item.subject} ultimately feel in this situation?\n\n` +
    `## Choices for Question 1\n${letterEncode(item.emotion_choices)}\n\n` +
    `## Question 2\nWhy would ${item.subject} feel these emotions in this situation?\n\n` +
    `## Choices for Question 2\n${letterEncode(item.cause_choices)}`
  );
}

function buildAffectBlock(scenarioText: string): string {
  const affect = classifyAffect(scenarioText);
  return (
    `\n\n## USER AFFECT CONTEXT\n` +
    `Observation about the user's current emotional state — not an instruction to change your tone.\n` +
    `- Emotion: ${affect.emotion}\n` +
    `- Valence: ${affect.valence.toFixed(2)} (negative ← 0 → positive)\n` +
    `- Arousal: ${affect.arousal.toFixed(2)} (calm ← 0 → activated)`
  );
}

// ============ Response Parsing ============

function extractResponseText(content: ContentBlock[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('');
}

function parseJSON(raw: string): Record<string, string> {
  // Try raw JSON first, then strip ```json fences
  const trimmed = raw.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```json?\s*/i, '').replace(/\s*```$/, ''),
    trimmed.replace(/^```\s*/i, '').replace(/\s*```$/, ''),
  ];

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {
      // try next candidate
    }
  }

  // Last resort: find first { ... } in the string
  const match = raw.match(/\{[^}]+\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      // give up
    }
  }

  return {};
}

function extractLetter(value: unknown): string {
  if (typeof value !== 'string') return '';
  const match = value.match(/^([A-Z])/);
  return match ? match[1] : '';
}

// ============ LLM Runner ============

/** Concurrency limit for parallel API calls */
const CONCURRENCY = 10;

/** Run async tasks with bounded concurrency */
export async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number = CONCURRENCY,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function callLLM(
  provider: MoonshotProvider,
  systemPrompt: string,
  userPrompt: string,
): Promise<Record<string, string>> {
  const request: CompletionRequest = {
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    temperature: 0.6,
    maxTokens: 100,
  };

  const response = await provider.complete(request);
  const text = extractResponseText(response.content);
  return parseJSON(text);
}

// ============ EA Evaluation ============

export async function runEACondition(
  provider: MoonshotProvider,
  items: EAItem[],
  enriched: boolean,
): Promise<EAResult[]> {
  return mapConcurrent(items, async (item) => {
    const systemPrompt = enriched
      ? SYSTEM_PROMPT + EA_RESPONSE_FMT + buildAffectBlock(item.scenario)
      : SYSTEM_PROMPT + EA_RESPONSE_FMT;

    const userPrompt = buildEAPrompt(item);
    const parsed = await callLLM(provider, systemPrompt, userPrompt);
    const predicted = extractLetter(parsed.answer);

    // Find the correct letter for the label
    const labelIdx = item.choices.indexOf(item.label);
    const labelLetter = labelIdx >= 0 ? String.fromCharCode(65 + labelIdx) : '';

    return {
      qid: item.qid,
      category: item.category,
      correct: predicted === labelLetter,
      predicted,
      label: labelLetter,
    };
  });
}

// ============ EU Evaluation ============

export async function runEUCondition(
  provider: MoonshotProvider,
  items: EUItem[],
  enriched: boolean,
): Promise<EUResult[]> {
  return mapConcurrent(items, async (item) => {
    const systemPrompt = enriched
      ? SYSTEM_PROMPT + EU_RESPONSE_FMT + buildAffectBlock(item.scenario)
      : SYSTEM_PROMPT + EU_RESPONSE_FMT;

    const userPrompt = buildEUPrompt(item);
    const parsed = await callLLM(provider, systemPrompt, userPrompt);
    const predictedEmo = extractLetter(parsed.answer_q1);
    const predictedCause = extractLetter(parsed.answer_q2);

    // Find correct letters
    const emoIdx = item.emotion_choices.indexOf(item.emotion_label);
    const emoLetter = emoIdx >= 0 ? String.fromCharCode(65 + emoIdx) : '';
    const causeIdx = item.cause_choices.indexOf(item.cause_label);
    const causeLetter = causeIdx >= 0 ? String.fromCharCode(65 + causeIdx) : '';

    const emoCorrect = predictedEmo === emoLetter;
    const causeCorrect = predictedCause === causeLetter;

    return {
      qid: item.qid,
      category: item.coarse_category,
      emoCorrect,
      causeCorrect,
      bothCorrect: emoCorrect && causeCorrect,
      predictedEmo,
      predictedCause,
      labelEmo: emoLetter,
      labelCause: causeLetter,
    };
  });
}

// ============ AFINN-165 Direct Classifier ============

/** Map EmoBench emotion labels to expected valence sign */
const POSITIVE_EMOTIONS = new Set([
  'Delight', 'Joy', 'Pride', 'Hope', 'Hopeful', 'Relief',
  'Love', 'Gratitude', 'Excitement', 'Amusement', 'Admiration',
  'Caring', 'Acceptance', 'Sentimental',
]);

const NEGATIVE_EMOTIONS = new Set([
  'Anger', 'Sadness', 'Fear', 'Disappointment', 'Embarrassment',
  'Guilt', 'Anxiety', 'Disgust', 'Annoyance', 'Horror',
  'Grief', 'Loathe', 'Disapproval', 'Nervousness', 'Remorse',
  'Hopeless',
]);

const NEUTRAL_EMOTIONS = new Set(['Surprise', 'Curiosity', 'Oblivious', 'Unbothered']);

function getExpectedValenceSign(emotionLabel: string): 'positive' | 'negative' | 'neutral' {
  // Handle compound emotions (e.g., "Gratitude & Joy") — use first emotion
  const parts = emotionLabel.split('&').map(s => s.trim());
  for (const part of parts) {
    if (POSITIVE_EMOTIONS.has(part)) return 'positive';
    if (NEGATIVE_EMOTIONS.has(part)) return 'negative';
    if (NEUTRAL_EMOTIONS.has(part)) return 'neutral';
  }
  return 'neutral';
}

function getExpectedQuadrant(emotionLabel: string): 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'neutral' {
  // Simplified quadrant expectation based on first emotion
  const parts = emotionLabel.split('&').map(s => s.trim());
  const first = parts[0];

  // High-arousal positive (Q1)
  const q1 = new Set(['Excitement', 'Joy', 'Delight', 'Amusement']);
  // Low-arousal positive (Q2)
  const q2 = new Set(['Calm', 'Relief', 'Acceptance', 'Sentimental', 'Caring', 'Love', 'Gratitude', 'Admiration']);
  // Low-arousal negative (Q3)
  const q3 = new Set(['Sadness', 'Disappointment', 'Grief', 'Guilt', 'Hopeless', 'Embarrassment']);
  // High-arousal negative (Q4)
  const q4 = new Set(['Anger', 'Anxiety', 'Horror', 'Nervousness', 'Annoyance', 'Disgust', 'Loathe', 'Disapproval', 'Remorse']);

  if (q1.has(first)) return 'Q1';
  if (q2.has(first)) return 'Q2';
  if (q3.has(first)) return 'Q3';
  if (q4.has(first)) return 'Q4';

  // Compound labels or unmapped — check valence
  if (POSITIVE_EMOTIONS.has(first)) return 'Q2'; // default positive to low-arousal
  if (NEGATIVE_EMOTIONS.has(first)) return 'Q3'; // default negative to low-arousal
  return 'neutral';
}

function getDetectedQuadrant(valence: number, arousal: number): 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'neutral' {
  if (Math.abs(valence) < 0.05 && Math.abs(arousal) < 0.05) return 'neutral';
  if (valence > 0 && arousal > 0) return 'Q1';
  if (valence > 0 && arousal <= 0) return 'Q2';
  if (valence <= 0 && arousal <= 0) return 'Q3';
  return 'Q4';
}

export function runAFINNDirect(items: EUItem[]): AFINNResult[] {
  const results: AFINNResult[] = [];

  for (const item of items) {
    const affect = classifyAffect(item.scenario);
    const expectedSign = getExpectedValenceSign(item.emotion_label);

    let valenceCorrect = false;
    if (expectedSign === 'positive') valenceCorrect = affect.valence > 0;
    else if (expectedSign === 'negative') valenceCorrect = affect.valence < 0;
    else valenceCorrect = Math.abs(affect.valence) < 0.15; // neutral = near zero

    const expectedQ = getExpectedQuadrant(item.emotion_label);
    const detectedQ = getDetectedQuadrant(affect.valence, affect.arousal);
    const quadrantCorrect = expectedQ === detectedQ;

    results.push({
      qid: item.qid,
      emotionLabel: item.emotion_label,
      detectedValence: affect.valence,
      detectedArousal: affect.arousal,
      detectedEmotion: affect.emotion,
      expectedValenceSign: expectedSign,
      valenceCorrect,
      quadrantCorrect,
    });
  }

  return results;
}

// ============ Scoring ============

function scoreEA(results: EAResult[]): { overall: number; byCategory: Record<string, number> } {
  const byCategory: Record<string, { correct: number; total: number }> = {};

  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { correct: 0, total: 0 };
    byCategory[r.category].total++;
    if (r.correct) byCategory[r.category].correct++;
  }

  const totalCorrect = results.filter(r => r.correct).length;
  const overall = results.length > 0 ? totalCorrect / results.length : 0;

  const categoryAccuracy: Record<string, number> = {};
  for (const [cat, counts] of Object.entries(byCategory)) {
    categoryAccuracy[cat] = counts.total > 0 ? counts.correct / counts.total : 0;
  }

  return { overall, byCategory: categoryAccuracy };
}

function scoreEU(results: EUResult[]): { overall: number; byCategory: Record<string, number> } {
  const byCategory: Record<string, { correct: number; total: number }> = {};

  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { correct: 0, total: 0 };
    byCategory[r.category].total++;
    if (r.bothCorrect) byCategory[r.category].correct++;
  }

  const totalCorrect = results.filter(r => r.bothCorrect).length;
  const overall = results.length > 0 ? totalCorrect / results.length : 0;

  const categoryAccuracy: Record<string, number> = {};
  for (const [cat, counts] of Object.entries(byCategory)) {
    categoryAccuracy[cat] = counts.total > 0 ? counts.correct / counts.total : 0;
  }

  return { overall, byCategory: categoryAccuracy };
}

function scoreAFINN(results: AFINNResult[]): {
  valenceAccuracy: number;
  quadrantAccuracy: number;
  totalItems: number;
} {
  const valenceCorrect = results.filter(r => r.valenceCorrect).length;
  const quadrantCorrect = results.filter(r => r.quadrantCorrect).length;

  return {
    valenceAccuracy: results.length > 0 ? valenceCorrect / results.length : 0,
    quadrantAccuracy: results.length > 0 ? quadrantCorrect / results.length : 0,
    totalItems: results.length,
  };
}

// ============ Report ============

function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (align === 'right') return s.padStart(width);
  return s.padEnd(width);
}

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
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

export function printEmoBenchReport(results: EmoBenchResults): void {
  const banner = [
    '',
    '='.repeat(60),
    '    EmoBench Results (English, Moonshot kimi-k2.5)',
    '='.repeat(60),
    '',
  ].join('\n');

  // EA table
  const eaCats = [
    ...new Set([
      ...Object.keys(results.ea.baseline.byCategory),
      ...Object.keys(results.ea.scallopbot.byCategory),
    ]),
  ].sort();

  const eaRows: string[][] = eaCats.map(cat => [
    cat,
    fmt(results.ea.baseline.byCategory[cat] ?? 0),
    fmt(results.ea.scallopbot.byCategory[cat] ?? 0),
  ]);
  eaRows.push([
    'Overall',
    fmt(results.ea.baseline.overall),
    fmt(results.ea.scallopbot.overall),
  ]);

  const eaTable = buildTable(
    ['Category', 'Baseline', 'ScallopBot'],
    eaRows,
    [18, 8, 10],
  );

  // EU table
  const euCats = [
    ...new Set([
      ...Object.keys(results.eu.baseline.byCategory),
      ...Object.keys(results.eu.scallopbot.byCategory),
    ]),
  ].sort();

  const euRows: string[][] = euCats.map(cat => [
    cat,
    fmt(results.eu.baseline.byCategory[cat] ?? 0),
    fmt(results.eu.scallopbot.byCategory[cat] ?? 0),
  ]);
  euRows.push([
    'Overall',
    fmt(results.eu.baseline.overall),
    fmt(results.eu.scallopbot.overall),
  ]);

  const euTable = buildTable(
    ['Category', 'Baseline', 'ScallopBot'],
    euRows,
    [35, 8, 10],
  );

  // AFINN table
  const afinnRows: string[][] = [
    ['Valence accuracy', fmt(results.afinn.valenceAccuracy)],
    ['Quadrant accuracy', fmt(results.afinn.quadrantAccuracy)],
    ['Total items', results.afinn.totalItems.toString()],
  ];

  const afinnTable = buildTable(
    ['Metric', 'Value'],
    afinnRows,
    [20, 8],
  );

  const report = [
    banner,
    'EA (Emotional Application):',
    eaTable,
    '',
    'EU (Emotional Understanding):',
    euTable,
    '',
    'AFINN-165 Direct Classifier (EU scenarios):',
    afinnTable,
    '',
  ].join('\n');

  console.log(report);
}

// ============ Main Runner ============

export async function runEmoBench(options?: {
  dataDir?: string;
  outputPath?: string;
}): Promise<EmoBenchResults> {
  const dataDir = options?.dataDir ?? path.resolve(process.cwd(), 'data/emobench');
  const outputPath =
    options?.outputPath ?? path.resolve(process.cwd(), 'results/emobench-results.json');

  // Load data
  const { eu, ea } = loadEmoBenchData(dataDir);
  console.log(`Loaded ${eu.length} EU items, ${ea.length} EA items (English)`);

  // Create provider
  const moonshotKey = process.env.MOONSHOT_API_KEY;
  if (!moonshotKey) {
    throw new Error(
      'MOONSHOT_API_KEY not found in environment. Set it to run LLM conditions.',
    );
  }

  const provider = new MoonshotProvider({
    apiKey: moonshotKey,
    model: 'kimi-k2.5',
    timeout: 30_000,
  });

  // Run EA conditions
  console.log('\nRunning EA baseline...');
  const eaBaseline = await runEACondition(provider, ea, false);
  console.log('Running EA ScallopBot...');
  const eaScallopbot = await runEACondition(provider, ea, true);

  // Run EU conditions
  console.log('Running EU baseline...');
  const euBaseline = await runEUCondition(provider, eu, false);
  console.log('Running EU ScallopBot...');
  const euScallopbot = await runEUCondition(provider, eu, true);

  // Run AFINN-165 direct
  console.log('Running AFINN-165 direct classifier...');
  const afinnResults = runAFINNDirect(eu);

  // Score
  const results: EmoBenchResults = {
    timestamp: new Date().toISOString(),
    model: 'kimi-k2.5',
    ea: {
      baseline: scoreEA(eaBaseline),
      scallopbot: scoreEA(eaScallopbot),
    },
    eu: {
      baseline: scoreEU(euBaseline),
      scallopbot: scoreEU(euScallopbot),
    },
    afinn: scoreAFINN(afinnResults),
  };

  // Print report
  printEmoBenchReport(results);

  // Write results JSON
  const resultsDir = path.dirname(outputPath);
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`Results written to: ${outputPath}`);

  return results;
}
