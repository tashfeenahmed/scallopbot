/**
 * Compaction recall exam  —  `npm run bench:compaction`
 *
 * Takes long real sessions (from a read-only COPY of a ScallopBot
 * memories.db), builds the context each policy would send, then asks the
 * model exact-answer recall questions using only that context:
 *
 *   full        – the whole transcript, uncompacted (ceiling; skipped when over the window)
 *   lean        – Phase 4 lean compaction (summary call + anchors + quotes + stubs)
 *   compactSync – the old cheap pipeline (dedupe → snip → drop thinking → prune) to ≤ 50k
 *   last8       – the old replay: visible text of the last 8 turns
 *
 * The question file holds answer keys copied from real transcripts, so it is
 * local-only: evals/compaction/questions.json (evals/ is gitignored because
 * this repository is public). Results go to evals/compaction/RESULTS.md.
 *
 * Question file shape:
 *   { "source": "pi-data/tashbot/memories.db",
 *     "exams": [{ "name", "description", "sessionIds": [...], "questions":
 *       [{ "id", "q", "answers": [...], "match"?: "normalized" | "word" | "all" }] }] }
 *
 * Env:
 *   MOONSHOT_API_KEY             required (environment or --env <file>, default ./.env)
 *   COMPACTION_EVAL_DB           source DB (default <repo>/<source>)
 *   COMPACTION_EVAL_QUESTIONS    question file (default evals/compaction/questions.json)
 *   COMPACTION_EVAL_MODEL        default kimi-k2.6
 *   COMPACTION_EVAL_WINDOW       context window for boundaries (default 256000)
 * Flags: --env <file>  --no-write  --repeat <n>  --exam <name>
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MoonshotProvider } from '../src/providers/moonshot.js';
import type { LLMProvider, Message } from '../src/providers/types.js';
import { buildReplayMessages, type ReplayInputMessage } from '../src/context/replay.js';
import { estimateTokens, leanCompact } from '../src/context/lean-compaction.js';
import { compactSync } from '../src/routing/compaction-pipeline.js';
import { compactCompletedConversationHistory } from '../src/memory/session-message-view.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

interface Question { id: string; q: string; answers: string[]; match?: 'normalized' | 'word' | 'all' }
interface Exam { name: string; description: string; sessionIds: string[]; questions: Question[] }
interface QuestionFile { source: string; exams: Exam[] }

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isCorrect(answer: string, question: Question): boolean {
  if (!answer || /^\s*unknown\s*$/i.test(answer)) return false;
  const hit = (key: string) => question.match === 'word'
    ? new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(key)}($|[^\\p{L}\\p{N}])`, 'iu').test(answer)
    : normalize(answer).includes(normalize(key));
  return question.match === 'all' ? question.answers.every(hit) : question.answers.some(hit);
}

function loadSessions(dbFile: string, sessionIds: string[]): ReplayInputMessage[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-eval-'));
  const copy = path.join(tmp, 'memories.db');
  fs.copyFileSync(dbFile, copy);
  if (fs.existsSync(`${dbFile}-wal`)) fs.copyFileSync(`${dbFile}-wal`, `${copy}-wal`);
  const db = new Database(copy, { readonly: true, fileMustExist: true });
  try {
    const columns = new Set((db.prepare('PRAGMA table_info(session_messages)').all() as { name: string }[]).map(column => column.name));
    const kind = columns.has('message_kind') ? 'message_kind' : 'NULL AS message_kind';
    const statement = db.prepare(`SELECT role, content, ${kind} FROM session_messages WHERE session_id = ? ORDER BY id`);
    return sessionIds.flatMap(sessionId => (statement.all(sessionId) as { role: string; content: string; message_kind: string | null }[])
      .map(row => ({ role: row.role, content: row.content, messageKind: (row.message_kind as ReplayInputMessage['messageKind']) ?? null })));
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const QUIZ_SYSTEM = 'You are the assistant from the conversation provided. Answer recall questions about it. Tools are not available; never call tools.';

function quizPrompt(questions: Question[]): string {
  return [
    'RECALL EXAM. Using ONLY the conversation above (including any tool calls, tool results and compaction summaries), answer each question.',
    'Copy identifiers, numbers, paths and names exactly. If the conversation above does not contain the answer, write "UNKNOWN" — do not guess.',
    'Reply with JSON only: {"answers": ["...", ...]} — one string per question, in order.',
    '',
    ...questions.map((question, index) => `${index + 1}. ${question.q}`),
  ].join('\n');
}

function parseAnswers(text: string, count: number): string[] {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { answers?: unknown[] };
    const answers = (parsed.answers ?? []).map(answer => String(answer ?? ''));
    return Array.from({ length: count }, (_, index) => answers[index] ?? '');
  } catch {
    return Array.from({ length: count }, () => '');
  }
}

async function askQuiz(provider: LLMProvider, context: Message[], questions: Question[]): Promise<{ answers: string[]; promptTokens: number }> {
  const messages: Message[] = [...context, { role: 'user', content: quizPrompt(questions) }];
  const response = await provider.complete({ system: QUIZ_SYSTEM, messages, maxTokens: 3_000, temperature: 0 });
  const text = response.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n');
  return { answers: parseAnswers(text, questions.length), promptTokens: response.usage.inputTokens };
}

interface ConditionResult {
  name: string;
  estimatedTokens: number;
  promptTokens: number[];
  correct: number[];
  perQuestion: Record<string, boolean[]>;
  answers: Record<string, string[]>;
  notes?: string;
  skipped?: string;
}

async function runExam(
  exam: Exam,
  dbFile: string,
  provider: LLMProvider,
  options: { windowTokens: number; repeat: number },
): Promise<{ exam: Exam; messageCount: number; tokens: number; results: ConditionResult[] }> {
  const messages = loadSessions(dbFile, exam.sessionIds);
  const tokens = estimateTokens(messages);
  console.log(`\n[${exam.name}] ${messages.length} messages, ~${tokens} tokens (estimate).`);

  const full = buildReplayMessages(messages);
  const started = Date.now();
  const summaryErrors: string[] = [];
  const lean = await leanCompact({
    messages, windowTokens: options.windowTokens, provider, summaryTimeoutMs: 300_000,
    onSummaryError: error => summaryErrors.push(String((error as Error)?.message ?? error)),
  });
  if (!lean) throw new Error(`[${exam.name}] lean compaction found nothing to compact`);
  const leanMs = Date.now() - started;
  const sync = compactSync(full, { targetTokens: 50_000, preserveLastN: 6 });
  const last8 = compactCompletedConversationHistory(full, { maxCompletedTurns: 8, maxVisibleCharsPerMessage: 2_000 });

  const conditions: { name: string; context: Message[]; notes?: string; skip?: string }[] = [
    {
      name: 'full (uncompacted ceiling)', context: full,
      skip: estimateTokens(full) > options.windowTokens * 0.85 ? `~${estimateTokens(full)} tokens exceeds 85% of the ${options.windowTokens} window` : undefined,
    },
    {
      name: 'lean (Phase 4)', context: lean.messages,
      notes: `compacted ${lean.compactedMessageCount} msgs into the summary; head ${lean.state.headEnd} msgs; tail from msg ${lean.state.tailStart} of ${messages.length}; summary by ${lean.usedFallback ? 'DETERMINISTIC FALLBACK' : 'LLM'} in ${(leanMs / 1000).toFixed(1)} s; summary message ${lean.state.summaryMessage.length} chars${summaryErrors.length ? `; summary errors: ${summaryErrors.join(' | ')}` : ''}`,
    },
    { name: 'compactSync ≤50k (old pipeline)', context: sync.messages, notes: `stages: ${sync.stagesApplied.join(', ') || 'none'}; fits 50k: ${sync.fits}` },
    { name: 'last 8 turns visible text (old replay)', context: last8 },
  ];

  const results: ConditionResult[] = [];
  for (const condition of conditions) {
    const result: ConditionResult = {
      name: condition.name, estimatedTokens: estimateTokens(condition.context), promptTokens: [], correct: [],
      perQuestion: {}, answers: {}, notes: condition.notes, skipped: condition.skip,
    };
    if (condition.skip) {
      console.log(`${condition.name}: skipped (${condition.skip})`);
      results.push(result);
      continue;
    }
    for (let run = 0; run < options.repeat; run++) {
      try {
        const { answers, promptTokens } = await askQuiz(provider, condition.context, exam.questions);
        result.promptTokens.push(promptTokens);
        let correct = 0;
        exam.questions.forEach((question, index) => {
          const ok = isCorrect(answers[index], question);
          if (ok) correct++;
          (result.perQuestion[question.id] ??= []).push(ok);
          (result.answers[question.id] ??= []).push(answers[index]);
        });
        result.correct.push(correct);
        console.log(`${condition.name} run ${run + 1}: ${correct}/${exam.questions.length} (prompt ${promptTokens} tokens)`);
      } catch (error) {
        result.skipped = `quiz call failed: ${String((error as Error)?.message ?? error).slice(0, 200)}`;
        console.log(`${condition.name}: ${result.skipped}`);
        break;
      }
    }
    results.push(result);
  }
  return { exam, messageCount: messages.length, tokens, results };
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

function renderExam(run: Awaited<ReturnType<typeof runExam>>): string[] {
  const n = run.exam.questions.length;
  const table = [
    '| Policy | Recall | Prompt tokens (provider-reported) | Estimated context tokens |',
    '|---|---|---|---|',
    ...run.results.map(result => result.skipped && result.correct.length === 0
      ? `| ${result.name} | skipped: ${result.skipped} | — | ${result.estimatedTokens} |`
      : `| ${result.name} | **${(100 * average(result.correct) / n).toFixed(0)}%** (${result.correct.join(', ')} / ${n}) | ${Math.round(average(result.promptTokens))} | ${result.estimatedTokens} |`),
  ];
  const active = run.results.filter(result => result.correct.length > 0);
  const perQuestion = [
    `| Question | ${active.map(result => result.name.split(' ')[0]).join(' | ')} |`,
    `|---|${active.map(() => '---').join('|')}|`,
    ...run.exam.questions.map(question => `| ${question.id} | ${active.map(result => {
      const marks = (result.perQuestion[question.id] ?? []).map(ok => (ok ? '✓' : '✗')).join('');
      const answer = (result.answers[question.id]?.[0] ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 50);
      return `${marks} ${answer}`;
    }).join(' | ')} |`),
  ];
  return [
    `## Exam: ${run.exam.name}`,
    '',
    `${run.exam.description}`,
    `Loaded ${run.messageCount} messages, ~${run.tokens} estimated tokens.`,
    '',
    ...table,
    '',
    ...run.results.filter(result => result.notes).map(result => `- ${result.name}: ${result.notes}`),
    '',
    '<details><summary>Per question (first-run answer)</summary>',
    '',
    ...perQuestion,
    '',
    '</details>',
    '',
  ];
}

async function main(): Promise<void> {
  loadEnvFile(arg('--env') ?? path.join(process.cwd(), '.env'));
  const apiKey = process.env.MOONSHOT_API_KEY;
  if (!apiKey) {
    console.error('MOONSHOT_API_KEY is not set (env or --env <file>). Not running — no results fabricated.');
    process.exit(2);
  }
  const questionsFile = process.env.COMPACTION_EVAL_QUESTIONS ?? path.join(repoRoot, 'evals/compaction/questions.json');
  if (!fs.existsSync(questionsFile)) {
    console.error(`Question file not found: ${questionsFile} (local-only; see the header of this script).`);
    process.exit(2);
  }
  const quiz = JSON.parse(fs.readFileSync(questionsFile, 'utf8')) as QuestionFile;
  const dbFile = process.env.COMPACTION_EVAL_DB ?? path.join(repoRoot, quiz.source);
  if (!fs.existsSync(dbFile)) {
    console.error(`Source DB not found: ${dbFile}. Set COMPACTION_EVAL_DB.`);
    process.exit(2);
  }
  const model = process.env.COMPACTION_EVAL_MODEL ?? 'kimi-k2.6';
  const windowTokens = Number(process.env.COMPACTION_EVAL_WINDOW ?? 256_000);
  const repeat = Math.max(1, Number(arg('--repeat') ?? 1));
  const only = arg('--exam');
  const provider = new MoonshotProvider({ apiKey, model, timeout: 300_000 });
  console.log(`Model ${model} (Moonshot), window ${windowTokens}, repeats ${repeat}.`);

  const runs = [];
  for (const exam of quiz.exams.filter(candidate => !only || candidate.name === only)) {
    runs.push(await runExam(exam, dbFile, provider, { windowTokens, repeat }));
    for (const line of renderExam(runs.at(-1)!).slice(0, 12)) console.log(line);
  }

  if (!process.argv.includes('--no-write')) {
    const lines = [
      '# Compaction recall exam — results',
      '',
      `Run: ${new Date().toISOString()} · model \`${model}\` (Moonshot) · window ${windowTokens} · repeats ${repeat}`,
      `Source: read-only copy of \`${quiz.source}\`. Plan target (Phase 4): **≥ 65% recall at ≤ 50k retained tokens**.`,
      'Recall is scored by exact-key match (case/punctuation-insensitive) on the model\'s answers, all 15 questions in one quiz call per policy.',
      '',
      ...runs.flatMap(renderExam),
      'Reproduce: `npm run bench:compaction -- --env /path/to/.env` (question file and DB are local-only).',
      '',
    ];
    const out = path.join(path.dirname(questionsFile), 'RESULTS.md');
    fs.writeFileSync(out, lines.join('\n'));
    console.log(`\nWrote ${path.relative(process.cwd(), out)}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
