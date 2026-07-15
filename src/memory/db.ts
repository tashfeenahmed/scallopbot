/**
 * SQLite Database Layer for ScallopMemory
 *
 * Provides persistent storage with:
 * - Memory entries with temporal grounding
 * - Relationship graph (UPDATES/EXTENDS/DERIVES)
 * - User profiles (static/dynamic/behavioral)
 * - Decay system support
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { createHash, randomUUID } from 'node:crypto';
import { nanoid } from 'nanoid';
import { redactSensitiveText } from '../security/redaction.js';
import type {
  MessageFrequencySignal,
  SessionEngagementSignal,
  TopicSwitchSignal,
  ResponseLengthSignal,
} from './behavioral-signals.js';
import type { AffectEMAState, SmoothedAffect } from './affect-smoothing.js';
import {
  buildSemanticLshProbes,
  computeSemanticLshBuckets,
  SEMANTIC_CANDIDATE_LIMIT,
  SEMANTIC_LSH_VERSION,
} from './semantic-index.js';
import {
  inferSessionMessageKind,
  isPersistedSessionMessageKind,
  PERSISTED_SESSION_MESSAGE_KINDS,
  type PersistedSessionMessageKind,
} from './session-message-kinds.js';
import {
  isAuthoritativeEvidenceReceipt,
  NEVER_AUTHORITATIVE_EVIDENCE_TOOLS,
  verifyResponseEvidenceClaims,
} from '../security/evidence-grounding.js';
import { sourceMemoryFingerprint } from './source-fingerprint.js';

const PERSISTED_MESSAGE_KIND_SQL = PERSISTED_SESSION_MESSAGE_KINDS
  .map(kind => `'${kind}'`)
  .join(', ');

/** Parse a JSON detail blob, returning null on malformed input. */
function parseDetailJSON(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Exponential retry delay; three failures open a day-long provider circuit. */
function summaryFailureBackoffMs(failureCount: number): number {
  if (failureCount < 3) return 60_000 * (2 ** Math.max(0, failureCount - 1));
  return Math.min(7 * 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000 * (2 ** (failureCount - 3)));
}

/**
 * Strong signals that a legacy task claimed fresh, externally verifiable
 * facts. Deliberately avoid generic words such as "report" and "current":
 * those appeared in ordinary workflow tasks and caused an earlier migration
 * to quarantine valid history merely because a tool happened to be declared.
 */
const LEGACY_FACTUAL_TASK_RE = /\b(?:analytics?|metrics?|statistics?|stats?|subscribers?|followers?|views?|revenue|traffic|conversions?|sales|balances?|prices?|exchange rates?|weather|flight status|stock prices?|account data|real data|source data|look ?up|research|fetch|retrieve|query|measure|counts?)\b/i;
const NON_EVIDENCE_SOURCE_TOOLS = new Set([
  'board', 'goals', 'reminder', 'triggers', 'progress', 'question', 'telegram_send',
]);

const PREMATURE_TASK_COMPLETION_RE = /^\s*(?:i(?:'ve| have)?|we(?:'ve| have)?|the (?:task|work|analysis|report))\s+(?:has\s+|have\s+|was\s+|were\s+)?(?:successfully\s+)?(?:completed|finished|created|generated|delivered|sent|published|deployed|done)\b/i;
const RELATIVE_MEMORY_DATE_RE = /\b(?:today|tomorrow|yesterday|next\s+(?:week|month|year)|last\s+(?:week|month|year))\b/gi;
const LEGACY_EXTERNAL_SUMMARY_CLAIM_RE = /\b(?:logged|saved|sent|updated|created|uploaded|deleted|booked|submitted|added|wrote|written|published|deployed)\b[^.!?]{0,160}\b(?:notion|tracker|dashboard|calendar|email|service|database|file|document|report|spreadsheet|github|slack|drive)\b|\b(?:notion|tracker|dashboard|calendar|email|service|database|file|document|report|spreadsheet|github|slack|drive)\b[^.!?]{0,160}\b(?:logged|saved|sent|updated|created|uploaded|deleted|booked|submitted|added|wrote|written|published|deployed)\b/i;

function normalizePendingTaskMessage(
  message: string,
  kind: ScheduledItemKind,
  taskConfig: TaskConfig | null | undefined,
): string {
  if (kind !== 'task' || !taskConfig?.goal?.trim()) return message;
  return PREMATURE_TASK_COMPLETION_RE.test(message) ? taskConfig.goal.trim() : message;
}

function isValidRuntimeEvidenceReceipt(value: unknown): value is ToolEvidenceReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<ToolEvidenceReceipt>;
  return typeof receipt.toolName === 'string'
    && receipt.toolName.trim().length > 0
    && receipt.success === true
    && typeof receipt.completedAt === 'number'
    && Number.isFinite(receipt.completedAt)
    && receipt.completedAt > 0
    && typeof receipt.outputBytes === 'number'
    && Number.isFinite(receipt.outputBytes)
    && receipt.outputBytes > 0
    && typeof receipt.outputDigest === 'string'
    && /^[a-f0-9]{64}$/i.test(receipt.outputDigest)
    && isAuthoritativeEvidenceReceipt(receipt as ToolEvidenceReceipt);
}

function recurringTaskSeriesKey(item: Pick<ScheduledItem, 'userId' | 'recurring' | 'taskConfig'>): string {
  const canonical = JSON.stringify({
    userId: item.userId,
    recurring: item.recurring ? {
      type: item.recurring.type,
      hour: item.recurring.hour,
      minute: item.recurring.minute,
      dayOfWeek: item.recurring.dayOfWeek ?? null,
      dayOfMonth: item.recurring.dayOfMonth ?? null,
    } : null,
    goal: item.taskConfig?.goal.trim().replace(/\s+/g, ' ').toLowerCase() ?? '',
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function recurringFailureFingerprint(error: string, failureCode?: string): string {
  const normalized = `${failureCode ?? 'task_execution_failed'}:${error}`
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Shared stop words for scheduled-item text similarity matching.
 * Used by consolidation, dedup, and cascade cancellation.
 */
const SCHEDULED_ITEM_STOP_WORDS = new Set([
  'the', 'a', 'an', 'at', 'on', 'in', 'to', 'for', 'of', 'and', 'is', 'are', 'was', 'were', 'been',
  'my', 'me', 'i', 'you', 'your', 'its', 'his', 'her', 'our', 'their',
  'with', 'from', 'has', 'have', 'had', 'will', 'can', 'not', 'but', 'this', 'that', 'about',
  'remind', 'reminder', 'remember', 'check', 'follow', 'up', 'user', 'upcoming', 'scheduled',
  'prepare', 'notes', 'ready', 'get', 'time', 'just', 'now', 'today', 'tomorrow',
  // Additional words to improve dedup between board-created and agent-created items
  'commitment', 'needs', 'need', 'should', 'must', 'gonna', 'going', 'plan', 'planning',
  'mentioned', 'said', 'told', 'wants', 'want', 'also', 'dont', 'forget', 'make', 'sure',
]);

/** Normalize text to significant word set for similarity matching */
function normalizeForSimilarity(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2 && !SCHEDULED_ITEM_STOP_WORDS.has(word))
  );
}

/** Strict similarity: |intersection| / |smaller set| threshold */
const DEDUP_SIMILARITY_STRICT = 0.8;
/** Lenient similarity: either side has this fraction overlap.
 *  Lowered from 0.4 → 0.3 to catch LLM-generated wording variations like
 *  "Day 6: Kitchen area + 1 cupboard" vs "Day 7: Kitchen area + 1 cupboard"
 *  that previously slipped through and caused proactive-message bursts. */
const DEDUP_SIMILARITY_LENIENT = 0.3;

/**
 * Memory types for decay calculation
 */
export type ScallopMemoryType =
  | 'static_profile'
  | 'dynamic_profile'
  | 'regular'
  | 'derived'
  | 'superseded';

/**
 * Memory categories
 */
export type MemoryCategory =
  | 'preference'
  | 'fact'
  | 'event'
  | 'relationship'
  | 'insight';

/**
 * Relationship types between memories
 */
export type RelationType = 'UPDATES' | 'EXTENDS' | 'DERIVES';

/**
 * Lightweight memory entry — same as ScallopMemoryEntry but without the
 * embedding vector.  Used for BM25/keyword scoring where loading and
 * JSON-parsing the 768-dim float[] per row is unnecessary overhead.
 */
export type ScallopMemoryEntryLight = Omit<ScallopMemoryEntry, 'embedding'> & { embedding: null };

/**
 * Core memory entry in SQLite
 */
export interface ScallopMemoryEntry {
  id: string;
  userId: string;
  content: string;
  category: MemoryCategory;
  memoryType: ScallopMemoryType;
  importance: number; // 1-10
  confidence: number; // 0.0-1.0
  isLatest: boolean;

  // Source attribution (defaults to 'user' if not specified)
  source?: 'user' | 'assistant';

  // Temporal grounding
  documentDate: number; // epoch ms - when recorded
  eventDate: number | null; // epoch ms - when event occurs

  // Decay system
  prominence: number;
  lastAccessed: number | null;
  accessCount: number;

  // Source chunk for hybrid retrieval
  sourceChunk: string | null;

  // Embedding (stored as JSON string in SQLite)
  embedding: number[] | null;

  // Metadata (stored as JSON string)
  metadata: Record<string, unknown> | null;

  // Source memory tracking (optional with defaults for backward compatibility)
  /** How the memory was learned: conversation, correction, inference, consolidation */
  learnedFrom?: string;
  /** Number of times this fact has been re-stated/confirmed */
  timesConfirmed?: number;
  /** JSON array of memory IDs that contradict this one */
  contradictionIds?: string[] | null;

  createdAt: number;
  updatedAt: number;
}

/** Filters applied inside the SQLite LSH candidate lookup. */
export interface SemanticCandidateOptions {
  userId?: string;
  category?: MemoryCategory;
  minProminence?: number;
  isLatest?: boolean;
  eventDateRange?: { start: number; end: number };
  documentDateRange?: { start: number; end: number };
  maxCandidates: number;
  /**
   * IDs already admitted by the caller's light-memory query. Passing this
   * avoids repeating category/date/prominence joins for every LSH probe.
   */
  eligibleIds?: Pick<ReadonlySet<string>, 'has'>;
  /** Optional tie-break metadata for eligible candidates. */
  candidatePriorities?: ReadonlyMap<string, { prominence: number; documentDate: number }>;
}

/**
 * Memory relation entry
 */
export interface MemoryRelation {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: RelationType;
  confidence: number;
  createdAt: number;
}

/**
 * User profile entry (key-value static facts)
 */
export interface UserProfileEntry {
  userId: string;
  key: string;
  value: string;
  confidence: number;
  updatedAt: number;
}

/**
 * Dynamic profile for a user
 */
export interface DynamicProfile {
  userId: string;
  recentTopics: string[];
  currentMood: string | null;
  activeProjects: string[];
  lastInteraction: number;
}

/**
 * Behavioral patterns for a user
 */
export interface BehavioralPatterns {
  userId: string;
  communicationStyle: string | null;
  expertiseAreas: string[];
  responsePreferences: Record<string, unknown>;
  activeHours: number[];
  /** EMA-smoothed daily message rate with trend (null = insufficient data) */
  messageFrequency: MessageFrequencySignal | null;
  /** EMA-smoothed session engagement with trend (null = insufficient data) */
  sessionEngagement: SessionEngagementSignal | null;
  /** Embedding-based topic switch rate (null = insufficient data) */
  topicSwitch: TopicSwitchSignal | null;
  /** EMA-smoothed message length evolution (null = insufficient data) */
  responseLength: ResponseLengthSignal | null;
  /** Affect EMA state for continuation across messages (null = no affect data yet) */
  affectState: AffectEMAState | null;
  /** Derived smoothed affect: emotion label, valence, arousal, goal signal (null = no affect data yet) */
  smoothedAffect: SmoothedAffect | null;
  updatedAt: number;
}

/**
 * Session entry
 */
export interface SessionRow {
  id: string;
  metadata: Record<string, unknown> | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: number;
  updatedAt: number;
  /** When the conversation was closed to new messages (for example by /new). */
  archivedAt: number | null;
  /** Machine-readable reason for closing the conversation. */
  archiveReason: string | null;
  /** When the raw transcript was deliberately removed after archival. */
  transcriptDeletedAt: number | null;
}

/** Append-only record of every session archive or transcript deletion. */
export interface SessionLifecycleEventRow {
  id: number;
  sessionId: string;
  userId: string | null;
  action: 'archived' | 'transcript_pruned' | 'forgotten';
  reason: string;
  actor: string;
  messageCount: number;
  createdAt: number;
}

/**
 * Session message entry
 */
export interface SessionMessageRow {
  id: number;
  sessionId: string;
  role: string;
  content: string;
  /** Explicit authorship/protocol semantics; never infer from role alone. */
  messageKind: PersistedSessionMessageKind;
  createdAt: number;
}

/**
 * Session summary entry (LLM-generated)
 */
export interface SessionSummaryRow {
  id: string;
  sessionId: string;
  userId: string;
  summary: string;
  topics: string[];
  messageCount: number;
  durationMs: number;
  embedding: number[] | null;
  createdAt: number;
  /** Null/false means this summary must never authorize transcript pruning. */
  verifiedAt?: number | null;
  verifier?: string | null;
  verificationVersion?: number | null;
  schemaValid?: boolean;
}

export type SessionSummaryInput = Omit<
  SessionSummaryRow,
  'id' | 'createdAt' | 'verifiedAt' | 'verifier' | 'verificationVersion' | 'schemaValid'
>;

export interface SessionSummaryVerificationRequest {
  verifier: string;
  verificationVersion: number;
  verifiedAt?: number;
}

export interface SessionSummaryVerificationEventRow {
  id: number;
  summaryId: string;
  sessionId: string;
  outcome: 'verified' | 'rejected';
  verifier: string;
  verificationVersion: number;
  reason: string;
  checkedAt: number;
}

export interface SessionSummaryRevisionRow extends SessionSummaryRow {
  revisionId: string;
  summaryId: string;
  revisionNumber: number;
  revisionReason: string;
  archivedAt: number;
}

/** Durable retry/circuit state for the structured session-summary route. */
export interface SessionSummaryFailureState {
  key: string;
  failureCount: number;
  lastFailureAt: number;
  nextRetryAt: number;
  lastErrorCode: string;
}

/**
 * Bot config entry
 */
export interface BotConfigRow {
  userId: string;
  botName: string;
  personalityId: string;
  customPersonality: string | null;
  modelId: string;
  timezone: string;
  onboardingComplete: boolean;
  onboardingStep: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Cost usage entry
 */
export interface CostUsageRow {
  id: number;
  model: string;
  provider: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  timestamp: number;
}

// ============ Unified Scheduled Items (Triggers + Reminders) ============

/**
 * Source of the scheduled item
 */
export type ScheduledItemSource = 'user' | 'agent';

/**
 * Provenance of the text stored in a scheduled item's message field.
 *
 * `source` identifies who initiated the item; it does not prove who authored
 * the stored text. Only trusted ingress that preserves text literally supplied
 * by the user may set `user_literal`. Model/tool-authored and legacy text must
 * remain `generated` so it crosses the proactive rendering boundary.
 */
export type ScheduledMessageProvenance = 'user_literal' | 'generated';

/**
 * Kind of scheduled item: nudge (pre-written message) or task (sub-agent work)
 */
export type ScheduledItemKind = 'nudge' | 'task';

/**
 * Configuration for task-kind scheduled items
 */
export interface TaskConfig {
  goal: string;
  tools?: string[];
  modelTier?: 'fast' | 'standard' | 'capable';
  /** Maximum worker attempts before the durable task is archived as failed. */
  maxAttempts?: number;
  /**
   * Evidence policy for unattended factual work. `tool_receipts` requires at
   * least one successful, runtime-issued tool receipt before a result can be
   * treated as success. When omitted, tasks that declare tools use this safer
   * policy automatically.
   */
  evidencePolicy?: 'none' | 'tool_receipts';
  /** Optional tool names that must each have a successful runtime receipt. */
  requiredEvidenceTools?: string[];
  /**
   * Missed-run policy. The safe default is `expire`: stale work is recorded
   * but never replayed unexpectedly. `run_once` is an explicit catch-up opt-in.
   */
  stalePolicy?: 'expire' | 'run_once';
  /** Maximum permitted lateness before `expire` applies (default: 24 hours). */
  maxLatenessMs?: number;
}

/**
 * Type of scheduled item
 */
export type ScheduledItemType =
  | 'reminder'         // User-set reminder
  | 'event_prep'       // Agent: prepare for upcoming event
  | 'commitment_check' // Agent: check on user's stated intention
  | 'goal_checkin'     // Agent: check in on long-term goal
  | 'follow_up';       // Agent: general follow-up

/**
 * Status of scheduled item
 */
export type ScheduledItemStatus =
  | 'pending'
  | 'processing'
  | 'fired'
  | 'dismissed'
  | 'expired'
  | 'acted'
  | 'blocked'
  | 'failed';

export type ProactiveSourceReplyAction = 'archive' | 'done' | 'snooze';

export interface ProactiveSourceReplyTransactionResult {
  acknowledged: boolean;
  replayed: boolean;
  sourceAction: {
    action: ProactiveSourceReplyAction;
    title: string;
    applied: boolean;
  } | null;
}

export type ProactiveDeliveryReservationResult =
  | { outcome: 'reserved'; token: string }
  | { outcome: 'daily_cap'; retryAt: number }
  | { outcome: 'min_gap'; retryAt: number };

export interface ProactiveDeliveryReceiptRow {
  id: number;
  channel: string;
  channelMessageId: string;
  scheduledItemId: string;
  ownerUserId: string;
  ambiguous: boolean;
  createdAt: number;
}

// ============ Board (Kanban) Types ============

/**
 * Board column status for kanban view
 */
export type BoardStatus = 'inbox' | 'backlog' | 'scheduled' | 'in_progress' | 'waiting' | 'done' | 'archived';

/**
 * Priority levels for board items
 */
export type Priority = 'urgent' | 'high' | 'medium' | 'low';

export type BoardTaskOutcome = 'succeeded' | 'failed' | 'blocked';

/** Privacy-preserving proof that a real tool ran during an isolated worker. */
export interface ToolEvidenceReceipt {
  toolName: string;
  success: boolean;
  completedAt: number;
  outputDigest: string;
  outputBytes: number;
  /** Bounded content-redacted hashes of normalized factual source claims. */
  claimDigests?: string[];
  claimLedgerTruncated?: boolean;
  /** Fail-closed runtime trust decision based on installed skill metadata. */
  authority?: 'authoritative' | 'untrusted';
  /** Privacy-safe installed source identity. */
  sourceDigest?: string;
  /** Privacy-safe digest of the exact tool request. */
  toolRequestDigest?: string;
  /** Privacy-safe scheduler request binding. */
  taskRequestDigest?: string;
  /** Privacy-safe durable owner/account binding. */
  accountScopeDigest?: string;
}

export interface RecurringTaskFailureCircuitResult {
  seriesKey: string;
  fingerprint: string;
  failureCount: number;
  opened: boolean;
  /** True exactly once, when this transaction reserves the user notification. */
  shouldNotify: boolean;
}

/** Result stored for any terminal or blocked board-task attempt. */
export interface BoardItemResult {
  response: string;
  completedAt: number;
  subAgentRunId?: string;
  iterationsUsed?: number;
  costUsd?: number;
  taskComplete?: boolean;
  notifiedAt?: number | null;
  /** Explicit outcome; legacy rows without this field are unverified. */
  outcome?: BoardTaskOutcome;
  /** Runtime-issued evidence only. Model-authored source claims are not proof. */
  evidenceReceipts?: ToolEvidenceReceipt[];
  /** Stable machine-readable reason for failed/blocked outcomes. */
  failureCode?: string;
  /** Whether completion was asserted by a user or a verified worker. */
  completionSource?: 'user' | 'worker';
}

/**
 * Recurring schedule types
 */
export type RecurringType = 'daily' | 'weekly' | 'monthly' | 'weekdays' | 'weekends';

/**
 * Recurring schedule configuration
 */
export interface RecurringSchedule {
  type: RecurringType;
  hour: number;       // 0-23
  minute: number;     // 0-59
  dayOfWeek?: number; // 0-6 (Sunday=0) for weekly
  dayOfMonth?: number; // 1-31 for monthly (short months clamp to their final day)
}

/** Validate persisted recurrence semantics before they become durable work. */
export function validateRecurringSchedule(schedule: RecurringSchedule, title?: string): void {
  if (!Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23) {
    throw new Error('Recurring schedule hour must be an integer from 0 to 23');
  }
  if (!Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59) {
    throw new Error('Recurring schedule minute must be an integer from 0 to 59');
  }
  if (schedule.type === 'weekly'
    && (!Number.isInteger(schedule.dayOfWeek) || schedule.dayOfWeek! < 0 || schedule.dayOfWeek! > 6)) {
    throw new Error('Weekly recurrence requires dayOfWeek from 0 to 6');
  }
  if (schedule.type === 'monthly'
    && (!Number.isInteger(schedule.dayOfMonth) || schedule.dayOfMonth! < 1 || schedule.dayOfMonth! > 31)) {
    throw new Error('Monthly recurrence requires dayOfMonth from 1 to 31');
  }

  // A clear cadence prefix is a durable contract, not decorative text. Fail
  // closed instead of silently storing "Monthly ..." as weekly work.
  const cadence = title?.trim().match(/^(daily|weekly|monthly)\b/i)?.[1]?.toLowerCase();
  if (cadence && cadence !== schedule.type) {
    throw new Error(`Recurring title says ${cadence} but schedule type is ${schedule.type}`);
  }
}

/**
 * Unified scheduled item entry - combines triggers and reminders
 */
export interface ScheduledItem {
  id: string;
  userId: string;
  sessionId: string | null;

  // Source distinction
  source: ScheduledItemSource;  // 'user' (explicit) | 'agent' (implicit)
  messageProvenance: ScheduledMessageProvenance;

  // Kind: nudge (pre-written message) or task (sub-agent work)
  kind: ScheduledItemKind;

  // Type/category
  type: ScheduledItemType;

  // Task configuration (for kind='task')
  taskConfig: TaskConfig | null;

  // Content
  message: string;              // The reminder/trigger message
  context: string | null;       // Additional context (for LLM message gen with agent items)

  // Scheduling
  triggerAt: number;            // epoch ms

  // Recurring support
  recurring: RecurringSchedule | null;

  // Status
  status: ScheduledItemStatus;
  firedAt: number | null;

  // Metadata
  sourceMemoryId: string | null; // For agent-created items
  /** Board item whose state caused this generated wrapper/nudge. */
  sourceItemId: string | null;

  // Board (kanban) fields
  boardStatus: BoardStatus | null;   // null = legacy item, compute from status
  priority: Priority;
  labels: string[] | null;
  result: BoardItemResult | null;
  dependsOn: string[] | null;        // IDs of items this depends on
  goalId: string | null;             // FK to memories.id (goal/milestone)

  // Durable task-worker ownership. Lease tokens stay internal to workers.
  workerId: string | null;
  preferredWorkerId: string | null;
  leaseToken: string | null;
  leasedAt: number | null;
  leaseExpiresAt: number | null;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  handedOffFrom: string | null;

  createdAt: number;
  updatedAt: number;
}

// ============ Sub-Agent Runs ============

/**
 * Sub-agent run row as stored in SQLite
 */
export interface SubAgentRunRow {
  id: string;
  parentSessionId: string;
  childSessionId: string;
  task: string;
  label: string;
  status: string;
  allowedSkills: string | null;
  modelTier: string;
  timeoutMs: number;
  resultResponse: string | null;
  resultIterations: number | null;
  resultTaskComplete: boolean | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  taskName?: string | null;
  parentRunId?: string | null;
  batchId?: string | null;
  batchIndex?: number | null;
  role?: string;
  spawnDepth?: number;
  contextMode?: string;
  workspaceMode?: string;
  workspacePath?: string | null;
  idleTimeoutMs?: number;
  hardTimeoutMs?: number;
  lastProgressAt?: number | null;
  resultJson?: string | null;
  updatedAt?: number;
}

export interface SubAgentDeliveryRow {
  runId: string;
  parentSessionId: string;
  userId: string | null;
  payloadJson: string;
  status: 'pending' | 'leased' | 'delivered' | 'failed';
  attempts: number;
  availableAt: number;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
}

/** Durable state for one externally-mutating tool dispatch. */
export type ToolOperationStatus = 'prepared' | 'succeeded' | 'failed' | 'uncertain';

export interface ToolOperationReservation {
  reserved: boolean;
  /** Existing durable state when the operation was not reserved. */
  existingStatus?: Exclude<ToolOperationStatus, 'failed'>;
}

export interface ToolOperationLedgerEntry {
  operationId: string;
  sessionId: string;
  toolName: string;
  status: ToolOperationStatus;
  createdAt: number;
  updatedAt: number;
}

/** Privacy-safe receipt for the single final outcome-decision boundary. */
export type BrainOutcomeKind = 'message' | 'action' | 'file';
export type BrainOutcomeDecision = 'approved' | 'revised' | 'suppressed' | 'blocked';

export interface BrainOutcomeRecordInput {
  id?: string;
  brainId: string;
  userId: string;
  sessionId?: string | null;
  source: string;
  kind: BrainOutcomeKind;
  proposalDigest: string;
  contextDigest: string;
  decision: BrainOutcomeDecision;
  reasonCode: string;
  finalDigest?: string | null;
  createdAt?: number;
}

export interface BrainOutcomeRow extends Required<Omit<BrainOutcomeRecordInput, 'id' | 'sessionId' | 'finalDigest' | 'createdAt'>> {
  id: string;
  sessionId: string | null;
  finalDigest: string | null;
  createdAt: number;
}

/**
 * Durable identity/status record for a goal hierarchy item.
 *
 * Goal rows historically lived only in `memories`, where ordinary memory
 * supersession and cleanup could make them disappear.  The registry is the
 * non-decaying source of identity; the memory row remains the searchable
 * projection and can be rebuilt from this record.
 */
export interface GoalRegistryEntry {
  id: string;
  userId: string;
  title: string;
  goalType: 'goal' | 'milestone' | 'task';
  status: 'backlog' | 'active' | 'completed';
  parentId: string | null;
  metadata: Record<string, unknown>;
  isPlaceholder: boolean;
  origin: 'memory' | 'scheduled_reference' | 'parent_reference';
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  deletedAt: number | null;
}

interface SqliteTableColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

/**
 * SQLite Database Manager for ScallopMemory
 */
export class ScallopDatabase {
  private db: Database.Database;
  private dbPath: string;
  private lastRetentionMaintenanceAt = 0;

  constructor(
    dbPath: string,
    options: { runRetentionMaintenance?: boolean } = {},
  ) {
    this.dbPath = dbPath;

    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Open database
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent performance
    this.db.pragma('journal_mode = WAL');

    // A partially initialized connection must never escape when a required
    // migration fails. Closing here also releases WAL/lock resources before
    // the startup error is reported to the caller.
    try {
      this.initializeSchema();
      if (options.runRetentionMaintenance !== false) this.runRetentionMaintenance();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /**
   * Initialize database schema
   */
  private initializeSchema(): void {
    this.db.exec(`
      -- Core memories table
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT 'regular',
        importance INTEGER DEFAULT 5,
        confidence REAL DEFAULT 0.8,
        is_latest INTEGER DEFAULT 1,

        -- Source attribution (user or assistant)
        source TEXT DEFAULT 'user',

        -- Temporal grounding
        document_date INTEGER NOT NULL,
        event_date INTEGER,

        -- Decay system
        prominence REAL DEFAULT 1.0,
        last_accessed INTEGER,
        access_count INTEGER DEFAULT 0,

        -- Source chunk for hybrid retrieval
        source_chunk TEXT,

        -- Embedding (JSON string)
        embedding TEXT,

        -- Metadata (JSON string)
        metadata TEXT,

        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Durable goal identity/status registry. Goals retain their identity
      -- here even if their searchable memory projection is superseded,
      -- accidentally removed, or explicitly deleted. deleted_at is a
      -- tombstone; registry rows themselves are never deleted by application
      -- code. There is intentionally no FK to memories.
      CREATE TABLE IF NOT EXISTS goal_registry (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        goal_type TEXT NOT NULL CHECK (goal_type IN ('goal', 'milestone', 'task')),
        status TEXT NOT NULL CHECK (status IN ('backlog', 'active', 'completed')),
        parent_id TEXT,
        metadata TEXT NOT NULL,
        is_placeholder INTEGER NOT NULL DEFAULT 0 CHECK (is_placeholder IN (0, 1)),
        origin TEXT NOT NULL DEFAULT 'memory'
          CHECK (origin IN ('memory', 'scheduled_reference', 'parent_reference')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        deleted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_goal_registry_user_status
        ON goal_registry(user_id, deleted_at, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_goal_registry_parent
        ON goal_registry(parent_id) WHERE parent_id IS NOT NULL;

      -- Append-only lifecycle receipts make migration repair and explicit
      -- deletion auditable without storing additional conversation content.
      CREATE TABLE IF NOT EXISTS goal_registry_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN (
          'backfilled', 'placeholder_created', 'restored_projection', 'deleted'
        )),
        detail TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goal_registry_events_goal
        ON goal_registry_events(goal_id, created_at DESC);

      -- Relationships between memories
      CREATE TABLE IF NOT EXISTS memory_relations (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        confidence REAL DEFAULT 0.8,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      -- User profiles (static facts)
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL DEFAULT 0.9,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
      );

      -- Dynamic profiles (recent context)
      CREATE TABLE IF NOT EXISTS dynamic_profiles (
        user_id TEXT PRIMARY KEY,
        recent_topics TEXT,
        current_mood TEXT,
        active_projects TEXT,
        last_interaction INTEGER NOT NULL
      );

      -- Behavioral patterns (weekly aggregation)
      CREATE TABLE IF NOT EXISTS behavioral_patterns (
        user_id TEXT PRIMARY KEY,
        communication_style TEXT,
        expertise_areas TEXT,
        response_preferences TEXT,
        active_hours TEXT,
        updated_at INTEGER NOT NULL
      );

      -- Sessions (replaces per-session .jsonl files)
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        metadata TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER,
        archive_reason TEXT,
        transcript_deleted_at INTEGER
      );

      -- Session messages
      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        message_kind TEXT NOT NULL CHECK (message_kind IN (
          'human_user', 'assistant_final', 'assistant_internal',
          'assistant_protocol', 'tool_result', 'worker_internal', 'system_internal'
        )),
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      -- Cold archive for lossless transcript retention. Raw rows move here
      -- before the hot session_messages copy is pruned; there is deliberately
      -- no cascading foreign key so the archive survives source lifecycle.
      CREATE TABLE IF NOT EXISTS session_message_archive (
        original_message_id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        message_kind TEXT NOT NULL CHECK (message_kind IN (
          'human_user', 'assistant_final', 'assistant_internal',
          'assistant_protocol', 'tool_result', 'worker_internal', 'system_internal'
        )),
        created_at INTEGER NOT NULL,
        archived_at INTEGER NOT NULL,
        archive_reason TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_message_archive_session
        ON session_message_archive(session_id, original_message_id);

      -- Append-only lifecycle audit. It intentionally has no foreign key: a
      -- deletion audit must outlive the data whose deletion it records.
      CREATE TABLE IF NOT EXISTS session_lifecycle_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_id TEXT,
        action TEXT NOT NULL CHECK (action IN ('archived', 'transcript_pruned', 'forgotten')),
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_lifecycle_events_session
        ON session_lifecycle_events(session_id, created_at DESC);

      -- Durable write-ahead ledger for external tool mutations. It contains
      -- hashes and routing metadata only: no user text, tool input, or output.
      -- A prepared/uncertain row deliberately survives restarts so a crash
      -- after dispatch cannot silently repeat an external side effect.
      CREATE TABLE IF NOT EXISTS tool_operation_ledger (
        operation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        call_signature TEXT NOT NULL,
        user_intent_digest TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('prepared', 'succeeded', 'failed', 'uncertain')),
        result_digest TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tool_operation_session
        ON tool_operation_ledger(session_id, updated_at DESC);

      -- Every dynamic user-visible message and tool/file side effect reaches
      -- one shared outcome brain before dispatch. This append-only ledger keeps
      -- only hashes and decision metadata: never prompts, payloads, messages,
      -- or private reasoning.
      CREATE TABLE IF NOT EXISTS brain_outcomes (
        id TEXT PRIMARY KEY,
        brain_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT,
        source TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('message', 'action', 'file')),
        proposal_digest TEXT NOT NULL,
        context_digest TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('approved', 'revised', 'suppressed', 'blocked')),
        reason_code TEXT NOT NULL,
        final_digest TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_brain_outcomes_user_time
        ON brain_outcomes(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_brain_outcomes_session_time
        ON brain_outcomes(session_id, created_at DESC);

      -- Bot configuration (replaces bot-config.json)
      CREATE TABLE IF NOT EXISTS bot_config (
        user_id TEXT PRIMARY KEY,
        bot_name TEXT NOT NULL DEFAULT 'ScallopBot',
        personality_id TEXT NOT NULL DEFAULT 'friendly',
        custom_personality TEXT,
        model_id TEXT NOT NULL DEFAULT 'moonshot-v1-128k',
        timezone TEXT NOT NULL DEFAULT 'UTC',
        onboarding_complete INTEGER NOT NULL DEFAULT 0,
        onboarding_step TEXT DEFAULT 'welcome',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Cost usage tracking (replaces in-memory array)
      CREATE TABLE IF NOT EXISTS cost_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );

      -- Unified scheduled items (triggers + reminders)
      CREATE TABLE IF NOT EXISTS scheduled_items (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT,

        -- Source distinction
        source TEXT NOT NULL,              -- 'user' (explicit) | 'agent' (implicit)

        -- Type/category
        type TEXT NOT NULL,                -- reminder|event_prep|commitment_check|goal_checkin|follow_up

        -- Content
        message TEXT NOT NULL,             -- The reminder/trigger message
        message_provenance TEXT NOT NULL DEFAULT 'generated'
          CHECK (message_provenance IN ('user_literal', 'generated')),
        context TEXT,                      -- Additional context (for LLM message gen)

        -- Scheduling
        trigger_at INTEGER NOT NULL,       -- epoch ms

        -- Recurring support (stored as JSON)
        recurring TEXT,                    -- JSON: {type, hour, minute, dayOfWeek?}

        -- Status
        status TEXT NOT NULL DEFAULT 'pending',  -- pending|fired|dismissed|expired
        fired_at INTEGER,

        -- Metadata
        source_memory_id TEXT,             -- For agent-created items
        source_item_id TEXT,               -- Board item that caused a generated wrapper/nudge

        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Durable circuit state for recurring task executions. A series key is
      -- a one-way digest of owner + cadence + normalized goal; raw failures are
      -- not retained here. notification_reserved_at makes the pause notice
      -- at-most-once even when multiple schedulers race after a restart.
      CREATE TABLE IF NOT EXISTS recurring_task_failure_circuits (
        series_key TEXT PRIMARY KEY,
        failure_fingerprint TEXT NOT NULL,
        failure_count INTEGER NOT NULL DEFAULT 0,
        opened_at INTEGER,
        notification_reserved_at INTEGER,
        last_failure_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recurring_task_failure_circuits_updated
        ON recurring_task_failure_circuits(updated_at DESC);

      -- Session summaries (LLM-generated summaries of past sessions)
      CREATE TABLE IF NOT EXISTS session_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'default',
        summary TEXT NOT NULL,
        topics TEXT,          -- JSON array of topic strings
        message_count INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        embedding TEXT,       -- JSON array (embedding vector)
        created_at INTEGER NOT NULL,
        verified_at INTEGER,
        verifier TEXT,
        verification_version INTEGER,
        schema_valid INTEGER NOT NULL DEFAULT 0 CHECK (schema_valid IN (0, 1))
      );

      -- Append-only verification receipts. Rejected/interim summaries remain
      -- preserved but cannot become a retention authorization.
      CREATE TABLE IF NOT EXISTS session_summary_verification_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        summary_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('verified', 'rejected')),
        verifier TEXT NOT NULL,
        verification_version INTEGER NOT NULL,
        reason TEXT NOT NULL,
        checked_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_summary_verification_receipt
        ON session_summary_verification_events(summary_id, verifier, verification_version);

      -- Lossless history for rejected summaries that are later regenerated.
      -- The current row keeps its stable ID; every prior value (and every
      -- rejected replacement candidate) is snapshotted here first.
      CREATE TABLE IF NOT EXISTS session_summary_revisions (
        id TEXT PRIMARY KEY,
        summary_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL,
        summary TEXT NOT NULL,
        topics TEXT,
        message_count INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        embedding TEXT,
        original_created_at INTEGER NOT NULL,
        verified_at INTEGER,
        verifier TEXT,
        verification_version INTEGER,
        schema_valid INTEGER NOT NULL DEFAULT 0 CHECK (schema_valid IN (0, 1)),
        revision_reason TEXT NOT NULL,
        archived_at INTEGER NOT NULL,
        UNIQUE(summary_id, revision_number)
      );
      CREATE INDEX IF NOT EXISTS idx_session_summary_revisions_session
        ON session_summary_revisions(session_id, revision_number);

      -- Summary generation failures are durable so a restart cannot reset a
      -- hot retry loop. Neither table cascades with sessions: these rows are
      -- part of the retention audit and provider-health circuit.
      CREATE TABLE IF NOT EXISTS session_summary_failures (
        session_id TEXT PRIMARY KEY,
        failure_count INTEGER NOT NULL,
        last_failure_at INTEGER NOT NULL,
        next_retry_at INTEGER NOT NULL,
        last_error_code TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS structured_route_circuits (
        route TEXT PRIMARY KEY,
        failure_count INTEGER NOT NULL,
        last_failure_at INTEGER NOT NULL,
        next_retry_at INTEGER NOT NULL,
        last_error_code TEXT NOT NULL
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_session_summaries_user ON session_summaries(user_id);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_summaries(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id, id);
      CREATE INDEX IF NOT EXISTS idx_cost_usage_timestamp ON cost_usage(timestamp);
      CREATE INDEX IF NOT EXISTS idx_cost_usage_session ON cost_usage(session_id);
      CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
      CREATE INDEX IF NOT EXISTS idx_memories_prominence ON memories(prominence DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_event_date ON memories(event_date);
      CREATE INDEX IF NOT EXISTS idx_memories_is_latest ON memories(is_latest);
      CREATE INDEX IF NOT EXISTS idx_memories_document_date ON memories(document_date);

      -- Dependency-free ANN candidate index. The vector itself remains in the
      -- memories table; these small integer signatures make semantic lookup
      -- bounded on low-memory Raspberry Pi deployments.
      CREATE TABLE IF NOT EXISTS memory_embedding_lsh (
        memory_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        index_version INTEGER NOT NULL,
        table_id INTEGER NOT NULL,
        bucket INTEGER NOT NULL,
        PRIMARY KEY (memory_id, index_version, table_id),
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memory_lsh_lookup
        ON memory_embedding_lsh(index_version, dimension, table_id, bucket, user_id);

      -- Compound indexes for light queries (getMemoriesByUserLight, getRecentMemoriesLight)
      CREATE INDEX IF NOT EXISTS idx_memories_user_latest_prom ON memories(user_id, is_latest, prominence DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_user_docdate ON memories(user_id, document_date DESC);

      CREATE INDEX IF NOT EXISTS idx_relations_source ON memory_relations(source_id);
      CREATE INDEX IF NOT EXISTS idx_relations_target ON memory_relations(target_id);
      CREATE INDEX IF NOT EXISTS idx_relations_type ON memory_relations(relation_type);

      -- Indexes for scheduled_items
      CREATE INDEX IF NOT EXISTS idx_scheduled_user ON scheduled_items(user_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_source ON scheduled_items(source);
      CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_items(status);
      CREATE INDEX IF NOT EXISTS idx_scheduled_trigger_at ON scheduled_items(trigger_at);
      CREATE INDEX IF NOT EXISTS idx_scheduled_pending ON scheduled_items(status, trigger_at) WHERE status = 'pending';

      -- Sub-agent runs (tracks sub-agent execution lifecycle)
      CREATE TABLE IF NOT EXISTS subagent_runs (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        child_session_id TEXT NOT NULL,
        task TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        allowed_skills TEXT,
        model_tier TEXT NOT NULL DEFAULT 'fast',
        timeout_ms INTEGER NOT NULL,
        result_response TEXT,
        result_iterations INTEGER,
        result_task_complete INTEGER,
        error TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        task_name TEXT,
        parent_run_id TEXT,
        batch_id TEXT,
        batch_index INTEGER,
        role TEXT NOT NULL DEFAULT 'leaf',
        spawn_depth INTEGER NOT NULL DEFAULT 0,
        context_mode TEXT NOT NULL DEFAULT 'brief',
        workspace_mode TEXT NOT NULL DEFAULT 'shared',
        workspace_path TEXT,
        idle_timeout_ms INTEGER NOT NULL DEFAULT 300000,
        hard_timeout_ms INTEGER NOT NULL DEFAULT 0,
        last_progress_at INTEGER,
        result_json TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent ON subagent_runs(parent_session_id);
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_status ON subagent_runs(status);

      -- Durable leased completion delivery. A completed background child
      -- is pushed to its parent/user without waiting for another parent turn.
      CREATE TABLE IF NOT EXISTS subagent_delivery_outbox (
        run_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        user_id TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        lease_token TEXT,
        lease_expires_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER,
        FOREIGN KEY (run_id) REFERENCES subagent_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_subagent_delivery_ready
        ON subagent_delivery_outbox(status, available_at, lease_expires_at);

      -- Auth: single web UI user
      CREATE TABLE IF NOT EXISTS auth_user (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Auth: session tokens
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_active INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

      -- Runtime key vault (API keys set by agent, persisted across restarts)
      CREATE TABLE IF NOT EXISTS runtime_keys (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Transcript chunks for cross-session recall (#9)
      CREATE TABLE IF NOT EXISTS transcript_chunks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        message_range_start INTEGER NOT NULL,
        message_range_end INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_transcript_chunks_session ON transcript_chunks(session_id);
      CREATE INDEX IF NOT EXISTS idx_transcript_chunks_user ON transcript_chunks(user_id);

      -- Persistent log of recently sent proactive messages so the in-memory
      -- dedup map (UnifiedScheduler.recentSends) survives restarts. Without
      -- this, every restart loses the dedup history, opening a window where
      -- recurring proactive items can fire with rephrased wording.
      CREATE TABLE IF NOT EXISTS proactive_send_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        message TEXT NOT NULL,
        source TEXT NOT NULL,
        sent_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_proactive_send_log_user_time
        ON proactive_send_log(user_id, sent_at DESC);

      -- Cross-process delivery slots. A short-lived reservation closes the
      -- check-then-send race between scheduler instances; successful delivery
      -- atomically becomes a proactive_send_log row.
      CREATE TABLE IF NOT EXISTS proactive_delivery_reservations (
        token TEXT PRIMARY KEY,
        item_id TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        reserved_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_proactive_delivery_reservation_user
        ON proactive_delivery_reservations(user_id, expires_at);

      -- Append-only provenance for channel deliveries. Message IDs are scoped
      -- by channel and owner because (for example) Telegram message_id values
      -- are chat-local. Multiple rows for one channel message deliberately
      -- represent ambiguity after queue combining and must never be collapsed.
      CREATE TABLE IF NOT EXISTS proactive_delivery_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        channel_message_id TEXT NOT NULL,
        scheduled_item_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        ambiguous INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous IN (0, 1)),
        created_at INTEGER NOT NULL,
        UNIQUE(channel, channel_message_id, scheduled_item_id, owner_user_id, ambiguous)
      );
      CREATE INDEX IF NOT EXISTS idx_proactive_delivery_receipt_lookup
        ON proactive_delivery_receipts(channel, channel_message_id, owner_user_id);
      CREATE INDEX IF NOT EXISTS idx_proactive_delivery_receipt_item
        ON proactive_delivery_receipts(scheduled_item_id, created_at);

      -- One trusted direct-reply action per delivered wrapper. This ledger is
      -- the idempotency key that prevents a retry from extending Snooze again.
      CREATE TABLE IF NOT EXISTS proactive_source_reply_actions (
        wrapper_id TEXT PRIMARY KEY,
        source_item_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('archive', 'done', 'snooze')),
        source_title TEXT NOT NULL,
        applied INTEGER NOT NULL,
        source_trigger_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_proactive_source_reply_source
        ON proactive_source_reply_actions(source_item_id, created_at);

      -- Observability log of proactive DECISIONS (not just sends): every time
      -- the evaluator or scheduler decides to create / skip / suppress / deliver
      -- a proactive message, it records why here. Powers the why-no-proact
      -- diagnostic so a silent "nothing fired" can be traced to the exact gate.
      CREATE TABLE IF NOT EXISTS proactive_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        stage TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_proactive_decisions_at
        ON proactive_decisions(at DESC);

      -- LLM call traces for fine-tune dataset building (see trace-tap.ts).
      -- Full rendered prompt + raw response per tagged structured call
      -- (fact_extract, memory_manage, relation_classify, rerank,
      -- session_summary, tool_call). parsed_ok=0 rows are the failures the
      -- fine-tune should eliminate; parsed_ok=1 rows from strong models are
      -- training targets. Pruned by retention (pruneLlmTraces) after pull.
      CREATE TABLE IF NOT EXISTS llm_traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        purpose TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        prompt TEXT NOT NULL,
        response TEXT NOT NULL,
        parsed_ok INTEGER NOT NULL,
        session_id TEXT,
        latency_ms INTEGER,
        stop_reason TEXT,
        request_max_tokens INTEGER,
        model_context_window_tokens INTEGER,
        model_max_output_tokens INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_llm_traces_ts ON llm_traces(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_llm_traces_purpose ON llm_traces(purpose, ts DESC);

      -- Self-evolution engine — Layer 1 corpus of improvement signals captured
      -- at the end of agent turns (reusable tasks, skill failures, low-quality
      -- answers). The nightly optimizer harvests these to propose mutations.
      CREATE TABLE IF NOT EXISTS evolution_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        target_skill TEXT,
        critic_score REAL,
        tool_call_count INTEGER,
        session_id TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_evolution_signals_at
        ON evolution_signals(at DESC);

      -- Self-evolution observability log: every harvest/reflect/verify/promote/
      -- rollback decision, powering the why-evolution diagnostic.
      CREATE TABLE IF NOT EXISTS evolution_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        stage TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT,
        target TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_evolution_decisions_at
        ON evolution_decisions(at DESC);

      -- Promoted-mutation ledger: snapshots the prior version of a target before a
      -- mutation goes live, so a regressing change can be auto-rolled-back. status:
      -- active | superseded | rolled_back. snapshot is the prior artifact or null
      -- if the target did not exist before (then rollback = delete).
      CREATE TABLE IF NOT EXISTS evolution_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target TEXT NOT NULL,
        kind TEXT NOT NULL,
        at INTEGER NOT NULL,
        baseline_fitness REAL,
        snapshot TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_evolution_versions_target
        ON evolution_versions(target, at DESC);

      -- Machine-authored prompt fragments (e.g. 'learned_guidance') appended to the
      -- system prompt when active. The optimizer's patch_prompt path writes here;
      -- the agent reads active rows each turn. One active row per fragment_id.
      CREATE TABLE IF NOT EXISTS prompt_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fragment_id TEXT NOT NULL,
        content TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_overrides_fragment
        ON prompt_overrides(fragment_id, active);
    `);

    // Old public databases declared session_summaries as a cascading child of
    // sessions. Rebuild the small durable table in-place without the FK before
    // any retention logic can run.
    this.migrateDecoupleSessionSummaries();
    this.migrateAddSessionMessageKinds();
    this.migrateAddSessionSummaryVerification();
    this.migrateQuarantineLegacyUnprovenSessionSummaries();

    // Existing public databases may predate the one-active-version invariant.
    // Normalize duplicates before creating the partial unique index.
    this.migrateNormalizeEvolutionVersions();

    // Migration: Add source column to existing databases
    this.migrateAddSourceColumn();

    // Migration: Add timezone column to bot_config
    this.migrateAddTimezoneColumn();

    // Migration: Add source memory columns (learned_from, times_confirmed, contradiction_ids)
    this.migrateAddSourceMemoryColumns();
    this.migrateSeparateRetrievalTelemetryFromFreshness();
    this.migrateRepairRelativeNremMemories();
    this.migrateDeduplicateNremSourceSets();

    // Migration: Clean polluted memory entries (skill outputs, assistant responses stored as facts)
    this.migrateCleanPollutedMemories();
    this.migrateReclassifySelfReflectionMemories();

    // Migration: Add kind and task_config columns to scheduled_items
    this.migrateAddKindColumn();

    // Migration: Separate item origin from authorship of its outbound text.
    this.migrateAddScheduledMessageProvenance();

    // Migration: Add board (kanban) columns to scheduled_items
    this.migrateAddBoardColumns();

    // Migration: Link generated wrapper nudges to the board item that caused them.
    this.migrateAddScheduledSourceItem();

    // Migration: Add durable task lease/retry/handoff columns
    this.migrateAddBoardExecutionColumns();

    // Migration: Preserve and repair legacy rows whose lifecycle and board
    // columns disagree, then enforce the invariant for every future writer.
    this.migrateReconcileScheduledItemStates();

    // Goals are durable application state, not ordinary memories. Backfill a
    // dedicated registry (including dangling legacy board references) before
    // installing fail-closed reference triggers for new scheduled work.
    this.migrateDurableGoalRegistry();

    // Quarantine provably inconsistent or unverified historical task rows
    // losslessly, then restore active goal records to durable storage semantics.
    this.migrateQuarantineRecurringCadenceMismatches();
    this.migrateReconcilePrematureTaskCompletionMessages();
    this.migrateQuarantineUnverifiedTaskResults();
    this.migrateDurableGoalMemories();

    // Migration: Create FTS5 virtual table for transcript chunk search
    this.migrateCreateTranscriptFTS();

    // Migration: Add model/token-limit diagnostics to llm_traces
    this.migrateAddLlmTraceMetadataColumns();

    // Migration: make conversation resets and retention lossless/auditable.
    this.migrateAddSessionLifecycleColumns();
    this.migrateSubAgentOrchestration();

    // Migration: Index embeddings written before the bounded semantic index
    // existed. This is a one-time startup cost; normal writes stay indexed.
    this.migrateBackfillEmbeddingLsh();
  }

  /**
   * Expand the public sub-agent ledger additively. This preserves every
   * historical row while enabling lineage, progress liveness and durable push.
   */
  private migrateSubAgentOrchestration(): void {
    const migrate = this.db.transaction(() => {
      const columns = new Set(
        (this.db.prepare('PRAGMA table_info(subagent_runs)').all() as SqliteTableColumn[])
          .map(column => column.name),
      );
      const additions: Array<[string, string]> = [
        ['task_name', 'TEXT'],
        ['parent_run_id', 'TEXT'],
        ['batch_id', 'TEXT'],
        ['batch_index', 'INTEGER'],
        ['role', "TEXT NOT NULL DEFAULT 'leaf'"],
        ['spawn_depth', 'INTEGER NOT NULL DEFAULT 0'],
        ['context_mode', "TEXT NOT NULL DEFAULT 'brief'"],
        ['workspace_mode', "TEXT NOT NULL DEFAULT 'shared'"],
        ['workspace_path', 'TEXT'],
        ['idle_timeout_ms', 'INTEGER NOT NULL DEFAULT 300000'],
        ['hard_timeout_ms', 'INTEGER NOT NULL DEFAULT 0'],
        ['last_progress_at', 'INTEGER'],
        ['result_json', 'TEXT'],
        ['updated_at', 'INTEGER NOT NULL DEFAULT 0'],
      ];
      for (const [name, definition] of additions) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE subagent_runs ADD COLUMN ${name} ${definition}`);
      }
      this.db.exec(`
        UPDATE subagent_runs SET hard_timeout_ms = timeout_ms
        WHERE hard_timeout_ms = 0 AND timeout_ms > 0;
        UPDATE subagent_runs SET updated_at = COALESCE(completed_at, started_at, created_at)
        WHERE updated_at = 0;
      `);
    });
    try {
      migrate();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`[migration] migrateSubAgentOrchestration failed: ${detail}`, { cause: error });
    }
  }

  /**
   * Additive session lifecycle migration. Existing conversations remain active
   * and all existing messages/summaries stay untouched.
   */
  private migrateAddSessionLifecycleColumns(): void {
    const migrate = this.db.transaction(() => {
      const columns = new Set(
        (this.db.prepare('PRAGMA table_info(sessions)').all() as SqliteTableColumn[])
          .map(column => column.name),
      );
      if (!columns.has('archived_at')) {
        this.db.exec('ALTER TABLE sessions ADD COLUMN archived_at INTEGER');
      }
      if (!columns.has('archive_reason')) {
        this.db.exec('ALTER TABLE sessions ADD COLUMN archive_reason TEXT');
      }
      if (!columns.has('transcript_deleted_at')) {
        this.db.exec('ALTER TABLE sessions ADD COLUMN transcript_deleted_at INTEGER');
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_active_updated
          ON sessions(updated_at DESC)
          WHERE archived_at IS NULL AND transcript_deleted_at IS NULL
      `);
    });

    try {
      migrate();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`[migration] migrateAddSessionLifecycleColumns failed: ${detail}`, { cause: error });
    }
  }

  /** Preserve every summary while removing the legacy ON DELETE CASCADE FK. */
  private migrateDecoupleSessionSummaries(): void {
    const foreignKeys = this.db.prepare('PRAGMA foreign_key_list(session_summaries)').all() as Array<{
      table: string;
    }>;
    if (!foreignKeys.some(key => key.table === 'sessions')) return;
    const existingColumns = new Set(
      (this.db.prepare('PRAGMA table_info(session_summaries)').all() as SqliteTableColumn[])
        .map(column => column.name),
    );
    const verifiedAt = existingColumns.has('verified_at') ? 'verified_at' : 'NULL';
    const verifier = existingColumns.has('verifier') ? 'verifier' : 'NULL';
    const verificationVersion = existingColumns.has('verification_version')
      ? 'verification_version'
      : 'NULL';
    const schemaValid = existingColumns.has('schema_valid') ? 'schema_valid' : '0';

    const migrate = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE session_summaries_without_session_fk (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          user_id TEXT NOT NULL DEFAULT 'default',
          summary TEXT NOT NULL,
          topics TEXT,
          message_count INTEGER DEFAULT 0,
          duration_ms INTEGER DEFAULT 0,
          embedding TEXT,
          created_at INTEGER NOT NULL,
          verified_at INTEGER,
          verifier TEXT,
          verification_version INTEGER,
          schema_valid INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO session_summaries_without_session_fk
          (id, session_id, user_id, summary, topics, message_count, duration_ms,
           embedding, created_at, verified_at, verifier, verification_version, schema_valid)
        SELECT id, session_id, user_id, summary, topics, message_count, duration_ms,
          embedding, created_at, ${verifiedAt}, ${verifier}, ${verificationVersion}, ${schemaValid}
        FROM session_summaries;
        DROP TABLE session_summaries;
        ALTER TABLE session_summaries_without_session_fk RENAME TO session_summaries;
        CREATE INDEX idx_session_summaries_user ON session_summaries(user_id);
        CREATE INDEX idx_session_summaries_session ON session_summaries(session_id);
        CREATE INDEX idx_session_summaries_created ON session_summaries(created_at DESC);
      `);
    });

    try {
      migrate();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`[migration] migrateDecoupleSessionSummaries failed: ${detail}`, { cause: error });
    }
  }

  /** Add and backfill durable message semantics for hot and cold transcripts. */
  private migrateAddSessionMessageKinds(): void {
    const migrate = this.db.transaction(() => {
      const hotColumns = new Set(
        (this.db.prepare('PRAGMA table_info(session_messages)').all() as SqliteTableColumn[])
          .map(column => column.name),
      );
      if (!hotColumns.has('message_kind')) {
        this.db.exec('ALTER TABLE session_messages ADD COLUMN message_kind TEXT');
      }
      const coldColumns = new Set(
        (this.db.prepare('PRAGMA table_info(session_message_archive)').all() as SqliteTableColumn[])
          .map(column => column.name),
      );
      if (!coldColumns.has('message_kind')) {
        this.db.exec('ALTER TABLE session_message_archive ADD COLUMN message_kind TEXT');
      }

      const validKinds = PERSISTED_MESSAGE_KIND_SQL;
      const hotSelect = this.db.prepare(`
        SELECT sm.id, sm.role, sm.content, s.metadata
        FROM session_messages sm
        LEFT JOIN sessions s ON s.id = sm.session_id
        WHERE sm.message_kind IS NULL OR sm.message_kind NOT IN (${validKinds})
        LIMIT 500
      `);
      const coldSelect = this.db.prepare(`
        SELECT archive.original_message_id AS id, archive.role, archive.content, s.metadata
        FROM session_message_archive archive
        LEFT JOIN sessions s ON s.id = archive.session_id
        WHERE archive.message_kind IS NULL OR archive.message_kind NOT IN (${validKinds})
        LIMIT 500
      `);
      const updateHot = this.db.prepare('UPDATE session_messages SET message_kind = ? WHERE id = ?');
      const updateCold = this.db.prepare(`
        UPDATE session_message_archive SET message_kind = ? WHERE original_message_id = ?
      `);

      const backfill = (
        select: Database.Statement,
        update: Database.Statement,
      ): void => {
        while (true) {
          const rows = select.all() as Array<{
            id: number;
            role: string;
            content: string;
            metadata: string | null;
          }>;
          if (rows.length === 0) return;
          for (const row of rows) {
            const metadata = row.metadata ? parseDetailJSON(row.metadata) : null;
            update.run(inferSessionMessageKind(row.role, row.content, metadata), row.id);
          }
        }
      };
      backfill(hotSelect, updateHot);
      backfill(coldSelect, updateCold);
    });

    try {
      migrate();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`[migration] migrateAddSessionMessageKinds failed: ${detail}`, { cause: error });
    }
  }

  /**
   * Add explicit verification state and conservatively audit only summaries
   * that existed before this migration. A sentinel prevents a later restart
   * from silently promoting newly-created unverified/interim summaries.
   */
  private migrateAddSessionSummaryVerification(): void {
    const migrate = this.db.transaction(() => {
      const columns = new Set(
        (this.db.prepare('PRAGMA table_info(session_summaries)').all() as SqliteTableColumn[])
          .map(column => column.name),
      );
      if (!columns.has('verified_at')) {
        this.db.exec('ALTER TABLE session_summaries ADD COLUMN verified_at INTEGER');
      }
      if (!columns.has('verifier')) {
        this.db.exec('ALTER TABLE session_summaries ADD COLUMN verifier TEXT');
      }
      if (!columns.has('verification_version')) {
        this.db.exec('ALTER TABLE session_summaries ADD COLUMN verification_version INTEGER');
      }
      if (!columns.has('schema_valid')) {
        this.db.exec('ALTER TABLE session_summaries ADD COLUMN schema_valid INTEGER NOT NULL DEFAULT 0');
      }

      const marker = this.db.prepare(`
        SELECT value FROM runtime_keys WHERE key = 'migration:session_summary_verification_v1'
      `).get();
      if (marker) return;

      const rows = this.db.prepare(
        'SELECT * FROM session_summaries ORDER BY created_at, id',
      ).all() as Record<string, unknown>[];
      const checkedAt = Date.now();
      let verified = 0;
      for (const row of rows) {
        const hasExplicitVerification = Number(row.schema_valid ?? 0) === 1
          && row.verified_at != null
          && typeof row.verifier === 'string'
          && row.verifier.length > 0
          && Number(row.verification_version ?? 0) > 0;
        const evaluation = this.evaluateSessionSummaryVerification({
          sessionId: String(row.session_id),
          summary: String(row.summary ?? ''),
          topics: this.parseSummaryTopics(row.topics),
          messageCount: Number(row.message_count ?? 0),
          durationMs: Number(row.duration_ms ?? 0),
        }, !hasExplicitVerification);
        if (evaluation.valid) verified++;
        const receiptVerifier = hasExplicitVerification
          ? String(row.verifier)
          : 'legacy_structural_audit';
        const receiptVersion = hasExplicitVerification
          ? Number(row.verification_version)
          : 1;
        this.db.prepare(`
          UPDATE session_summaries
          SET verified_at = ?, verifier = ?, verification_version = ?, schema_valid = ?
          WHERE id = ?
        `).run(
          evaluation.valid ? (hasExplicitVerification ? Number(row.verified_at) : checkedAt) : null,
          receiptVerifier,
          receiptVersion,
          evaluation.valid ? 1 : 0,
          row.id,
        );
        this.insertSessionSummaryVerificationEvent({
          summaryId: String(row.id),
          sessionId: String(row.session_id),
          outcome: evaluation.valid ? 'verified' : 'rejected',
          verifier: receiptVerifier,
          verificationVersion: receiptVersion,
          reason: evaluation.reason,
          checkedAt,
        });
      }

      const markerValue = JSON.stringify({ checked: rows.length, verified, checkedAt });
      this.db.prepare(`
        INSERT INTO runtime_keys (key, value, created_at, updated_at)
        VALUES ('migration:session_summary_verification_v1', ?, ?, ?)
      `).run(markerValue, checkedAt, checkedAt);
    });

    try {
      migrate();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`[migration] migrateAddSessionSummaryVerification failed: ${detail}`, { cause: error });
    }
  }

  /**
   * Version-1 summary verification checked transcript shape, not external-action
   * provenance. Invalidate only those legacy summaries that assert an external
   * completion; the summary and receipt history remain preserved for audit and
   * the version-2 summarizer can regenerate them safely.
   */
  private migrateQuarantineLegacyUnprovenSessionSummaries(): void {
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session_summary_provenance_quarantine (
          summary_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          summary_snapshot TEXT NOT NULL,
          reason TEXT NOT NULL,
          quarantined_at INTEGER NOT NULL
        )
      `);
      const rows = this.db.prepare(`
        SELECT * FROM session_summaries
        WHERE schema_valid = 1 AND verified_at IS NOT NULL
          AND COALESCE(verification_version, 0) < 2
          AND NOT EXISTS (
            SELECT 1 FROM session_summary_provenance_quarantine quarantine
            WHERE quarantine.summary_id = session_summaries.id
          )
      `).all() as Record<string, unknown>[];
      const audit = this.db.prepare(`
        INSERT INTO session_summary_provenance_quarantine
          (summary_id, session_id, summary_snapshot, reason, quarantined_at)
        VALUES (?, ?, ?, 'legacy_external_completion_claim_lacked_turn_receipt_verification', ?)
      `);
      const invalidate = this.db.prepare(`
        UPDATE session_summaries
        SET schema_valid = 0, verified_at = NULL
        WHERE id = ?
      `);
      const reject = this.db.prepare(`
        INSERT INTO session_summary_verification_events
          (summary_id, session_id, outcome, verifier, verification_version, reason, checked_at)
        VALUES (?, ?, 'rejected', 'provenance_migration', 2,
          'legacy_external_completion_claim_lacked_turn_receipt_verification', ?)
      `);
      const now = Date.now();
      for (const row of rows) {
        if (!LEGACY_EXTERNAL_SUMMARY_CLAIM_RE.test(String(row.summary))) continue;
        const snapshot = JSON.stringify({
          summary: row.summary,
          topics: row.topics,
          messageCount: row.message_count,
          durationMs: row.duration_ms,
          verifiedAt: row.verified_at,
          verifier: row.verifier,
          verificationVersion: row.verification_version,
        });
        audit.run(String(row.id), String(row.session_id), snapshot, now);
        invalidate.run(row.id);
        reject.run(String(row.id), String(row.session_id), now);
      }
    });
    migrate.immediate();
  }

  private migrateNormalizeEvolutionVersions(): void {
    const migrate = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE evolution_versions AS current
        SET status = 'superseded'
        WHERE current.status = 'active'
          AND EXISTS (
            SELECT 1 FROM evolution_versions AS newer
            WHERE newer.target = current.target AND newer.status = 'active'
              AND (newer.at > current.at OR (newer.at = current.at AND newer.id > current.id))
          )
      `).run();
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_evolution_versions_one_active_target
        ON evolution_versions(target) WHERE status = 'active'
      `);
    });
    migrate();
  }

  /** Backfill only missing/current-version signatures in small transactions. */
  private migrateBackfillEmbeddingLsh(): void {
    try {
      this.db.prepare('DELETE FROM memory_embedding_lsh WHERE index_version != ?')
        .run(SEMANTIC_LSH_VERSION);

      const findMissing = this.db.prepare(`
        SELECT m.id, m.user_id, m.embedding
        FROM memories m
        WHERE m.embedding IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM memory_embedding_lsh l
            WHERE l.memory_id = m.id AND l.index_version = ?
          )
        LIMIT 250
      `);
      const insert = this.db.prepare(`
        INSERT OR REPLACE INTO memory_embedding_lsh
          (memory_id, user_id, dimension, index_version, table_id, bucket)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const indexBatch = this.db.transaction((rows: Array<{
        id: string;
        user_id: string;
        embedding: string;
      }>) => {
        for (const row of rows) {
          let embedding: number[];
          try {
            const parsed = JSON.parse(row.embedding) as unknown;
            if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'number')) {
              throw new Error('embedding is not a numeric array');
            }
            embedding = parsed;
          } catch {
            // A sentinel isolates a malformed legacy row instead of allowing it
            // to block every valid memory later in the one-time backfill.
            insert.run(row.id, row.user_id, 0, SEMANTIC_LSH_VERSION, -1, 0);
            continue;
          }
          const signatures = computeSemanticLshBuckets(embedding);
          if (signatures.length === 0) {
            // Sentinel prevents an empty-but-valid JSON vector from being
            // rediscovered forever by the migration loop.
            insert.run(row.id, row.user_id, 0, SEMANTIC_LSH_VERSION, -1, 0);
          }
          for (const signature of signatures) {
            insert.run(
              row.id,
              row.user_id,
              embedding.length,
              SEMANTIC_LSH_VERSION,
              signature.tableId,
              signature.bucket,
            );
          }
        }
      });

      while (true) {
        const rows = findMissing.all(SEMANTIC_LSH_VERSION) as Array<{
          id: string;
          user_id: string;
          embedding: string;
        }>;
        if (rows.length === 0) break;
        indexBatch(rows);
      }
    } catch (error) {
      // Retrieval still has lexical candidates if index migration fails.
      if (error instanceof Error) {
        console.warn(`[migration] migrateBackfillEmbeddingLsh: ${error.message}`);
      }
    }
  }

  private replaceEmbeddingLsh(memoryId: string, userId: string, embedding: number[]): void {
    const replace = this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_embedding_lsh WHERE memory_id = ?').run(memoryId);
      const stmt = this.db.prepare(`
        INSERT INTO memory_embedding_lsh
          (memory_id, user_id, dimension, index_version, table_id, bucket)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const signatures = computeSemanticLshBuckets(embedding);
      if (signatures.length === 0) {
        stmt.run(memoryId, userId, 0, SEMANTIC_LSH_VERSION, -1, 0);
      }
      for (const signature of signatures) {
        stmt.run(
          memoryId,
          userId,
          embedding.length,
          SEMANTIC_LSH_VERSION,
          signature.tableId,
          signature.bucket,
        );
      }
    });
    replace();
  }

  /**
   * Add source column to memories table if it doesn't exist (migration for existing DBs)
   */
  private migrateAddSourceColumn(): void {
    try {
      // Check if column exists
      const tableInfo = this.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
      const hasSourceColumn = tableInfo.some(col => col.name === 'source');

      if (!hasSourceColumn) {
        this.db.exec("ALTER TABLE memories ADD COLUMN source TEXT DEFAULT 'user'");
      }
    } catch (error) {
      // Column might already exist or table might not exist yet — log for visibility
      if (error instanceof Error && !error.message.includes('duplicate column')) {
        console.warn(`[migration] migrateAddSourceColumn: ${error.message}`);
      }
    }
  }

  /**
   * Add timezone column to bot_config table if it doesn't exist (migration for existing DBs)
   */
  private migrateAddTimezoneColumn(): void {
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(bot_config)").all() as Array<{ name: string }>;
      const hasTimezoneColumn = tableInfo.some(col => col.name === 'timezone');

      if (!hasTimezoneColumn) {
        this.db.exec("ALTER TABLE bot_config ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'");
      }
    } catch (error) {
      if (error instanceof Error && !error.message.includes('duplicate column')) {
        console.warn(`[migration] migrateAddTimezoneColumn: ${error.message}`);
      }
    }
  }

  /**
   * Add source memory columns: learned_from, times_confirmed, contradiction_ids
   */
  private migrateAddSourceMemoryColumns(): void {
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
      const columns = new Set(tableInfo.map(col => col.name));

      if (!columns.has('learned_from')) {
        this.db.exec("ALTER TABLE memories ADD COLUMN learned_from TEXT DEFAULT 'conversation'");
      }
      if (!columns.has('times_confirmed')) {
        this.db.exec("ALTER TABLE memories ADD COLUMN times_confirmed INTEGER DEFAULT 1");
      }
      if (!columns.has('contradiction_ids')) {
        this.db.exec("ALTER TABLE memories ADD COLUMN contradiction_ids TEXT DEFAULT NULL");
      }
    } catch (error) {
      if (error instanceof Error && !error.message.includes('duplicate column')) {
        console.warn(`[migration] migrateAddSourceMemoryColumns: ${error.message}`);
      }
    }
  }

  /**
   * Older versions made every automatic lookup look like a content update by
   * writing the same timestamp to last_accessed and updated_at. Repair the
   * recoverable cases once; future lookups update retrieval telemetry only.
   *
   * Some public databases had already copied that contaminated timestamp into
   * the durable goal registry. Repair both projections in one transaction and
   * preserve the prior values in an additive audit table.
   */
  private migrateSeparateRetrievalTelemetryFromFreshness(): void {
    const repairedAt = Date.now();
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS retrieval_freshness_repair_audit (
          memory_id TEXT PRIMARY KEY,
          previous_memory_updated_at INTEGER NOT NULL,
          repaired_memory_updated_at INTEGER NOT NULL,
          previous_goal_updated_at INTEGER,
          repaired_goal_updated_at INTEGER,
          last_accessed INTEGER NOT NULL,
          repaired_at INTEGER NOT NULL
        )
      `);
      this.db.prepare(`
        INSERT OR IGNORE INTO retrieval_freshness_repair_audit (
          memory_id, previous_memory_updated_at, repaired_memory_updated_at,
          previous_goal_updated_at, repaired_goal_updated_at,
          last_accessed, repaired_at
        )
        SELECT
          m.id,
          m.updated_at,
          MAX(m.created_at, m.document_date),
          g.updated_at,
          CASE WHEN g.id IS NULL THEN NULL
            ELSE MAX(g.created_at, m.created_at, m.document_date, COALESCE(g.completed_at, 0)) END,
          m.last_accessed,
          ?
        FROM memories m
        LEFT JOIN goal_registry g ON g.id = m.id
        WHERE m.last_accessed IS NOT NULL
          AND (m.updated_at = m.last_accessed OR g.updated_at = m.last_accessed)
      `).run(repairedAt);
      this.db.exec(`
        UPDATE memories
        SET updated_at = MAX(created_at, document_date)
        WHERE last_accessed IS NOT NULL
          AND updated_at = last_accessed;

        UPDATE goal_registry
        SET updated_at = (
          SELECT MAX(
            goal_registry.created_at,
            memories.created_at,
            memories.document_date,
            COALESCE(goal_registry.completed_at, 0)
          )
          FROM memories
          WHERE memories.id = goal_registry.id
        )
        WHERE EXISTS (
          SELECT 1 FROM memories
          WHERE memories.id = goal_registry.id
            AND memories.last_accessed IS NOT NULL
            AND goal_registry.updated_at = memories.last_accessed
        );
      `);
    });
    migrate.immediate();
  }

  /**
   * Repair NREM memories that interpreted an old source's "today" at the time
   * the nightly job ran. A unique source event day is canonicalized to an
   * absolute date; ambiguous rows are merely superseded, never deleted.
   */
  private migrateRepairRelativeNremMemories(): void {
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS nrem_temporal_repair_audit (
          memory_id TEXT PRIMARY KEY,
          memory_snapshot TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK (outcome IN ('canonicalized', 'quarantined')),
          reason TEXT NOT NULL,
          repaired_at INTEGER NOT NULL
        )
      `);
      const rows = this.db.prepare(`
        SELECT id, content, event_date, metadata, memory_type, is_latest, updated_at
        FROM memories
        WHERE learned_from = 'nrem_consolidation' AND is_latest = 1
          AND NOT EXISTS (
            SELECT 1 FROM nrem_temporal_repair_audit audit
            WHERE audit.memory_id = memories.id
          )
      `).all() as Record<string, unknown>[];
      const audit = this.db.prepare(`
        INSERT INTO nrem_temporal_repair_audit
          (memory_id, memory_snapshot, outcome, reason, repaired_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const canonicalize = this.db.prepare(`
        UPDATE memories
        SET content = ?, event_date = ?, metadata = ?, updated_at = ?
        WHERE id = ? AND is_latest = 1
      `);
      const quarantine = this.db.prepare(`
        UPDATE memories
        SET is_latest = 0, memory_type = 'superseded', updated_at = ?
        WHERE id = ? AND is_latest = 1
      `);
      const getSource = this.db.prepare(`
        SELECT content, event_date, metadata FROM memories WHERE id = ?
      `);
      const hasRelativeDate = new RegExp(RELATIVE_MEMORY_DATE_RE.source, 'i');
      const now = Date.now();

      for (const row of rows) {
        const content = String(row.content);
        if (!hasRelativeDate.test(content)) continue;
        const metadata = row.metadata == null ? {} : (parseDetailJSON(String(row.metadata)) ?? {});
        const sourceIds = Array.isArray(metadata.sourceIds)
          ? metadata.sourceIds.filter((id): id is string => typeof id === 'string')
          : [];
        const sourceDates = new Map<string, number>();
        for (const sourceId of sourceIds) {
          const source = getSource.get(sourceId) as Record<string, unknown> | undefined;
          if (!source || source.event_date == null) continue;
          const sourceMetadata = source.metadata == null
            ? null
            : parseDetailJSON(String(source.metadata));
          if (sourceMetadata?.isRelativeDate !== true && !hasRelativeDate.test(String(source.content))) continue;
          const eventDate = Number(source.event_date);
          const day = new Date(eventDate).toISOString().slice(0, 10);
          if (!sourceDates.has(day)) sourceDates.set(day, eventDate);
        }
        const snapshot = JSON.stringify({
          content,
          eventDate: row.event_date,
          metadata,
          memoryType: row.memory_type,
          isLatest: row.is_latest,
          updatedAt: row.updated_at,
        });
        if (sourceDates.size !== 1) {
          audit.run(
            String(row.id), snapshot, 'quarantined',
            'relative_nrem_memory_has_no_unique_source_event_date', now,
          );
          quarantine.run(now, row.id);
          continue;
        }

        const [day, eventDate] = [...sourceDates.entries()][0];
        const repairedMetadata = {
          ...metadata,
          rawDateText: null,
          isRelativeDate: false,
          relativeDateCanonicalized: true,
          temporalSourceDate: day,
          temporalRepairVersion: 1,
        };
        const repairedContent = content.replace(RELATIVE_MEMORY_DATE_RE, `on ${day}`);
        audit.run(
          String(row.id), snapshot, 'canonicalized',
          'relative_nrem_memory_reanchored_to_unique_source_event_date', now,
        );
        canonicalize.run(repairedContent, eventDate, JSON.stringify(repairedMetadata), now, row.id);
      }
    });
    migrate.immediate();
  }

  /**
   * Older sleep cycles could consolidate the identical source cluster every
   * night. Keep the newest synthesis current and preserve every earlier row as
   * a superseded historical version with an additive audit receipt.
   */
  private migrateDeduplicateNremSourceSets(): void {
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS nrem_source_dedupe_audit (
          duplicate_memory_id TEXT PRIMARY KEY,
          canonical_memory_id TEXT NOT NULL,
          source_fingerprint TEXT NOT NULL,
          previous_memory_type TEXT NOT NULL,
          previous_is_latest INTEGER NOT NULL,
          repaired_at INTEGER NOT NULL
        )
      `);
      const rows = this.db.prepare(`
        SELECT id, user_id, memory_type, is_latest, metadata
        FROM memories
        WHERE learned_from = 'nrem_consolidation' AND is_latest = 1
        ORDER BY user_id, document_date DESC, created_at DESC, id
      `).all() as Record<string, unknown>[];
      const audit = this.db.prepare(`
        INSERT OR IGNORE INTO nrem_source_dedupe_audit (
          duplicate_memory_id, canonical_memory_id, source_fingerprint,
          previous_memory_type, previous_is_latest, repaired_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      const supersede = this.db.prepare(`
        UPDATE memories
        SET is_latest = 0, memory_type = 'superseded', updated_at = ?
        WHERE id = ? AND is_latest = 1
      `);
      const canonicalBySourceSet = new Map<string, string>();
      const repairedAt = Date.now();

      for (const row of rows) {
        const metadata = row.metadata == null
          ? null
          : parseDetailJSON(String(row.metadata));
        const sourceIds = Array.isArray(metadata?.sourceIds)
          ? metadata.sourceIds.filter((id): id is string => typeof id === 'string')
          : [];
        if (sourceIds.length < 2) continue;
        const fingerprint = sourceMemoryFingerprint(sourceIds);
        const key = `${String(row.user_id)}\u0000${fingerprint}`;
        const canonicalId = canonicalBySourceSet.get(key);
        if (!canonicalId) {
          canonicalBySourceSet.set(key, String(row.id));
          continue;
        }
        audit.run(
          String(row.id), canonicalId, fingerprint,
          String(row.memory_type), Number(row.is_latest), repairedAt,
        );
        supersede.run(repairedAt, row.id);
      }
    });
    migrate.immediate();
  }

  /** Assistant self-reflection is derived coaching, never user-authored memory. */
  private migrateReclassifySelfReflectionMemories(): void {
    try {
      this.db.prepare(`
        UPDATE memories
        SET source = 'assistant', memory_type = 'derived', updated_at = ?
        WHERE learned_from = 'self_reflection'
          AND (source != 'assistant' OR memory_type != 'derived')
      `).run(Date.now());
    } catch (error) {
      if (error instanceof Error) {
        console.warn(`[migration] migrateReclassifySelfReflectionMemories: ${error.message}`);
      }
    }
  }

  /**
   * Clean polluted memory entries: skill execution outputs, assistant responses,
   * and user questions that were incorrectly stored as facts.
   * Marks them as is_latest = 0 so they're excluded from search and context.
   */
  private migrateCleanPollutedMemories(): void {
    try {
      // Check if migration already ran (use a sentinel)
      const sentinel = this.db.prepare(
        "SELECT COUNT(*) as c FROM memories WHERE source = '_cleaned_sentinel'"
      ).get() as { c: number };
      if (sentinel.c > 0) return;

      // Run entire migration in a transaction so it's all-or-nothing.
      // If the process crashes mid-migration, the transaction rolls back and
      // re-run will execute cleanly (no sentinel = migration hasn't happened).
      const migrate = this.db.transaction(() => {
        // 1. Archive all skill execution outputs (source starts with 'skill:')
        const skillResult = this.db.prepare(
          "UPDATE memories SET is_latest = 0, memory_type = 'superseded' WHERE source LIKE 'skill:%' AND is_latest = 1"
        ).run();

        // 2. Archive ALL assistant responses — they are bot outputs, not user facts
        const assistantResult = this.db.prepare(
          "UPDATE memories SET is_latest = 0, memory_type = 'superseded' WHERE source = 'assistant' AND is_latest = 1"
        ).run();

        // 3. Archive entries that look like proactive check messages or scheduled reminders
        const proactiveResult = this.db.prepare(
          "UPDATE memories SET is_latest = 0, memory_type = 'superseded' WHERE (content LIKE '[PROACTIVE CHECK%' OR content LIKE '[SCHEDULED REMINDER%') AND is_latest = 1"
        ).run();

        // 4. Archive entries that are clearly user questions, not facts
        const questionResult = this.db.prepare(
          "UPDATE memories SET is_latest = 0, memory_type = 'superseded' WHERE source = 'user' AND is_latest = 1 AND (content LIKE 'what %' OR content LIKE 'how %' OR content LIKE 'do %' OR content LIKE 'can %' OR content LIKE 'where %' OR content LIKE 'when %' OR content LIKE 'why %' OR content LIKE 'who %') AND LENGTH(content) < 60"
        ).run();

        // 5. Archive any remaining entries with content > 300 chars (never real facts)
        const longResult = this.db.prepare(
          "UPDATE memories SET is_latest = 0, memory_type = 'superseded' WHERE LENGTH(content) > 300 AND is_latest = 1"
        ).run();

        // Insert sentinel inside the transaction so it commits atomically with updates
        const now = Date.now();
        this.db.prepare(
          "INSERT INTO memories (id, user_id, content, category, memory_type, importance, confidence, is_latest, source, document_date, prominence, access_count, created_at, updated_at) VALUES (?, 'default', 'Memory cleanup migration completed', 'fact', 'superseded', 0, 0, 0, '_cleaned_sentinel', ?, 0, 0, ?, ?)"
        ).run(`_cleanup_${now}`, now, now, now);

        // Also clean garbage profile values
        // Remove invalid timezone values (not IANA format)
        const tzRow = this.db.prepare(
          "SELECT value FROM user_profiles WHERE user_id = 'default' AND key = 'timezone'"
        ).get() as { value: string } | undefined;
        if (tzRow && !tzRow.value.includes('/') && tzRow.value !== 'UTC' && tzRow.value !== 'GMT') {
          this.db.prepare("DELETE FROM user_profiles WHERE user_id = 'default' AND key = 'timezone'").run();
          console.log(`[memory-cleanup] Removed invalid timezone: "${tzRow.value}"`);
        }

        // Remove mood values that describe bot behavior
        const moodRow = this.db.prepare(
          "SELECT value FROM user_profiles WHERE user_id = 'default' AND key = 'mood'"
        ).get() as { value: string } | undefined;
        if (moodRow && /\b(assist|help|check|remind|offer|execute|search|follow-up)\b/i.test(moodRow.value)) {
          this.db.prepare("DELETE FROM user_profiles WHERE user_id = 'default' AND key = 'mood'").run();
          console.log(`[memory-cleanup] Removed invalid mood: "${moodRow.value}"`);
        }

        // Trim overly long focus fields (keep max 5 items)
        const focusRow = this.db.prepare(
          "SELECT value FROM user_profiles WHERE user_id = 'default' AND key = 'focus'"
        ).get() as { value: string } | undefined;
        if (focusRow) {
          const items = focusRow.value.split(',').map(s => s.trim()).filter(Boolean);
          if (items.length > 5) {
            const trimmed = items.slice(0, 5).join(', ');
            this.db.prepare("UPDATE user_profiles SET value = ? WHERE user_id = 'default' AND key = 'focus'").run(trimmed);
            console.log(`[memory-cleanup] Trimmed focus from ${items.length} to 5 items`);
          }
        }

        return { skillResult, assistantResult, proactiveResult, questionResult, longResult };
      });

      const { skillResult, assistantResult, proactiveResult, questionResult, longResult } = migrate();
      const total = skillResult.changes + assistantResult.changes + proactiveResult.changes + questionResult.changes + longResult.changes;
      if (total > 0) {
        console.log(`[memory-cleanup] Archived ${total} polluted entries: ${skillResult.changes} skill outputs, ${assistantResult.changes} long assistant responses, ${proactiveResult.changes} proactive messages, ${questionResult.changes} questions, ${longResult.changes} oversized entries`);
      }
    } catch (error) {
      // Migration failure is non-fatal but log for debugging
      if (error instanceof Error) {
        console.warn(`[migration] migrateCleanPollutedMemories: ${error.message}`);
      }
    }
  }

  /**
   * Add kind and task_config columns to scheduled_items table if they don't exist.
   * Backfills event_prep items as kind='task'.
   */
  private migrateAddKindColumn(): void {
    this.runRequiredScheduledItemsMigration(
      'migrateAddKindColumn',
      [
        ['kind', "TEXT NOT NULL DEFAULT 'nudge'"],
        ['task_config', 'TEXT DEFAULT NULL'],
      ],
      () => {
        // Backfill: event_prep items become tasks.
        this.db.exec("UPDATE scheduled_items SET kind = 'task' WHERE type = 'event_prep'");
      },
    );
  }

  /**
   * Add fail-closed message authorship provenance. Existing rows cannot prove
   * they contain text literally supplied by a user, so the default/backfill is
   * deliberately `generated`.
   */
  private migrateAddScheduledMessageProvenance(): void {
    this.runRequiredScheduledItemsMigration(
      'migrateAddScheduledMessageProvenance',
      [[
        'message_provenance',
        "TEXT NOT NULL DEFAULT 'generated' CHECK (message_provenance IN ('user_literal', 'generated'))",
      ]],
      undefined,
      columns => {
        const provenance = columns.get('message_provenance')!;
        const defaultValue = provenance.dflt_value?.trim();
        if (
          provenance.type.trim().toUpperCase() !== 'TEXT'
          || provenance.notnull !== 1
          || (defaultValue !== "'generated'" && defaultValue !== '"generated"')
        ) {
          throw new Error(
            'scheduled_items.message_provenance has an incompatible schema; '
            + "expected TEXT NOT NULL DEFAULT 'generated'",
          );
        }

        const invalid = this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM scheduled_items
          WHERE message_provenance IS NULL
             OR message_provenance NOT IN ('user_literal', 'generated')
        `).get() as { count: number };
        if (invalid.count > 0) {
          throw new Error(
            `scheduled_items.message_provenance contains ${invalid.count} invalid value(s)`,
          );
        }
      },
    );
  }

  /**
   * Add board columns to scheduled_items table if they don't exist.
   * Adds: board_status, priority, labels, result, depends_on, goal_id
   */
  private migrateAddBoardColumns(): void {
    this.runRequiredScheduledItemsMigration(
      'migrateAddBoardColumns',
      [
        ['board_status', 'TEXT DEFAULT NULL'],
        ['priority', "TEXT DEFAULT 'medium'"],
        ['labels', 'TEXT DEFAULT NULL'],
        ['result', 'TEXT DEFAULT NULL'],
        ['depends_on', 'TEXT DEFAULT NULL'],
        ['goal_id', 'TEXT DEFAULT NULL'],
      ],
      () => {
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_board ON scheduled_items(user_id, board_status)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_priority ON scheduled_items(priority)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_goal ON scheduled_items(goal_id)');
        this.db.exec(`
          UPDATE scheduled_items
          SET board_status = CASE
            WHEN status = 'pending' AND trigger_at > 0 THEN 'scheduled'
            WHEN status = 'pending' THEN 'inbox'
            WHEN status = 'processing' THEN 'in_progress'
            WHEN status = 'blocked' THEN 'waiting'
            -- A row old enough to lack a board projection is historical. Keep
            -- its delivered lifecycle, but do not surface it as newly done or
            -- include it in a post-upgrade completion digest.
            WHEN status IN ('fired', 'acted') THEN 'archived'
            WHEN status IN ('dismissed', 'expired', 'failed') THEN 'archived'
            ELSE 'inbox'
          END
          WHERE board_status IS NULL
        `);
      },
    );
  }

  /** Add first-class provenance from a generated nudge to its source board item. */
  private migrateAddScheduledSourceItem(): void {
    this.runRequiredScheduledItemsMigration(
      'migrateAddScheduledSourceItem',
      [['source_item_id', 'TEXT DEFAULT NULL']],
      () => {
        // Lossless legacy backfill: only board-gap wrappers whose JSON sourceId
        // resolves to a same-owner scheduled item are linked. Memory/session IDs
        // and cross-owner references are deliberately ignored.
        this.db.exec(`
          UPDATE scheduled_items AS wrapper
          SET source_item_id = json_extract(
            CASE WHEN json_valid(wrapper.context) THEN wrapper.context ELSE '{}' END,
            '$.sourceId'
          )
          WHERE wrapper.source_item_id IS NULL
            AND wrapper.source = 'agent'
            AND json_valid(wrapper.context)
            AND json_extract(
              CASE WHEN json_valid(wrapper.context) THEN wrapper.context ELSE '{}' END,
              '$.gapType'
            ) IN ('stale_board_item', 'blocked_item')
            AND typeof(json_extract(
              CASE WHEN json_valid(wrapper.context) THEN wrapper.context ELSE '{}' END,
              '$.sourceId'
            )) = 'text'
            AND EXISTS (
              SELECT 1
              FROM scheduled_items AS source
              WHERE source.id = json_extract(
                  CASE WHEN json_valid(wrapper.context) THEN wrapper.context ELSE '{}' END,
                  '$.sourceId'
                )
                AND source.id != wrapper.id
                AND source.user_id = wrapper.user_id
            )
        `);
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_source_item ON scheduled_items(source_item_id)');
      },
    );
  }

  /** Add durable worker ownership, lease, retry, and handoff fields. */
  private migrateAddBoardExecutionColumns(): void {
    this.runRequiredScheduledItemsMigration(
      'migrateAddBoardExecutionColumns',
      [
        ['worker_id', 'TEXT DEFAULT NULL'],
        ['preferred_worker_id', 'TEXT DEFAULT NULL'],
        ['lease_token', 'TEXT DEFAULT NULL'],
        ['leased_at', 'INTEGER DEFAULT NULL'],
        ['lease_expires_at', 'INTEGER DEFAULT NULL'],
        ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['max_attempts', 'INTEGER NOT NULL DEFAULT 3'],
        ['last_error', 'TEXT DEFAULT NULL'],
        ['handed_off_from', 'TEXT DEFAULT NULL'],
      ],
      () => {
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_task_lease ON scheduled_items(kind, status, lease_expires_at)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_preferred_worker ON scheduled_items(preferred_worker_id)');
      },
      columns => {
        for (const [name, expectedDefault] of [
          ['attempt_count', '0'],
          ['max_attempts', '3'],
        ] as const) {
          const column = columns.get(name)!;
          if (
            column.type.trim().toUpperCase() !== 'INTEGER'
            || column.notnull !== 1
            || column.dflt_value?.trim() !== expectedDefault
          ) {
            throw new Error(
              `scheduled_items.${name} has an incompatible schema; `
              + `expected INTEGER NOT NULL DEFAULT ${expectedDefault}`,
            );
          }
        }
      },
    );
  }

  /**
   * Reconcile the two scheduled-item state projections without deleting or
   * reviving anything. The full pre-repair row is retained as JSON so an
   * operator can audit or restore every historical value.
   *
   * `status` is canonical. Terminal lifecycle rows can therefore never look
   * active to the board/proactive scanner. Conversely, a pending row already
   * marked terminal by the board is quarantined as expired instead of being
   * made executable again.
   */
  private migrateReconcileScheduledItemStates(): void {
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_item_state_reconciliation_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_id TEXT NOT NULL,
          previous_status TEXT NOT NULL,
          previous_board_status TEXT,
          reconciled_status TEXT NOT NULL,
          reconciled_board_status TEXT NOT NULL,
          reason TEXT NOT NULL,
          item_snapshot TEXT NOT NULL,
          reconciled_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_scheduled_state_audit_item
          ON scheduled_item_state_reconciliation_audit(item_id, reconciled_at);
      `);

      const rows = this.db.prepare(`
        SELECT * FROM scheduled_items
        WHERE NOT (
          (status = 'pending' AND board_status IN ('inbox', 'backlog', 'scheduled', 'waiting'))
          OR (status = 'processing' AND board_status = 'in_progress')
          OR (status = 'blocked' AND board_status = 'waiting')
          OR (status IN ('fired', 'acted') AND board_status IN ('done', 'archived'))
          OR (status IN ('dismissed', 'expired', 'failed') AND board_status = 'archived')
        )
      `).all() as Record<string, unknown>[];

      const audit = this.db.prepare(`
        INSERT INTO scheduled_item_state_reconciliation_audit (
          item_id, previous_status, previous_board_status,
          reconciled_status, reconciled_board_status,
          reason, item_snapshot, reconciled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const repair = this.db.prepare(`
        UPDATE scheduled_items
        SET status = ?, board_status = ?,
            last_error = CASE
              WHEN ? = 'quarantined_terminal_board_conflict'
                THEN COALESCE(last_error, 'Quarantined during scheduled-item state reconciliation')
              ELSE last_error
            END
        WHERE id = ?
      `);
      const now = Date.now();

      for (const row of rows) {
        const status = String(row.status);
        const boardStatus = row.board_status == null ? null : String(row.board_status);
        let reconciledStatus: ScheduledItemStatus;
        let reconciledBoardStatus: BoardStatus;
        let reason: string;

        if (status === 'processing' && boardStatus === 'done') {
          // A terminal board projection records a user/worker completion that
          // must win over a stale processing flag. Archive the historical row
          // so startup cannot execute or digest-notify it again.
          reconciledStatus = 'fired';
          reconciledBoardStatus = 'archived';
          reason = 'quarantined_processing_done_conflict';
        } else if (status === 'processing' && boardStatus === 'archived') {
          reconciledStatus = 'dismissed';
          reconciledBoardStatus = 'archived';
          reason = 'quarantined_processing_archived_conflict';
        } else if (status === 'pending' && (boardStatus === 'done' || boardStatus === 'archived')) {
          // A terminal board action must never be undone by making the row live.
          reconciledStatus = 'expired';
          reconciledBoardStatus = 'archived';
          reason = 'quarantined_terminal_board_conflict';
        } else if (status === 'pending') {
          reconciledStatus = 'pending';
          reconciledBoardStatus = Number(row.trigger_at) > 0 ? 'scheduled' : 'inbox';
          reason = 'repaired_pending_board_projection';
        } else if (status === 'processing') {
          // Keep in-flight/leased work in-flight; never expire or requeue it here.
          reconciledStatus = 'processing';
          reconciledBoardStatus = 'in_progress';
          reason = 'repaired_processing_board_projection';
        } else if (status === 'blocked') {
          reconciledStatus = 'blocked';
          reconciledBoardStatus = 'waiting';
          reason = 'repaired_blocked_board_projection';
        } else if (status === 'fired' || status === 'acted') {
          reconciledStatus = status;
          // A legacy completed row in an active-looking column is historical,
          // not newly completed. Archive it so startup cannot re-notify it in
          // a morning digest. The fired/acted delivery record remains intact.
          reconciledBoardStatus = 'archived';
          reason = 'quarantined_completed_board_conflict';
        } else {
          // Includes the real-world expired+in_progress ghost. Preserve its
          // lifecycle meaning and archive only its misleading board projection.
          reconciledStatus = status === 'dismissed'
            ? 'dismissed'
            : status === 'failed'
              ? 'failed'
              : 'expired';
          reconciledBoardStatus = 'archived';
          reason = 'repaired_terminal_board_projection';
        }

        audit.run(
          String(row.id),
          status,
          boardStatus,
          reconciledStatus,
          reconciledBoardStatus,
          reason,
          JSON.stringify(row),
          now,
        );
        repair.run(reconciledStatus, reconciledBoardStatus, reason, row.id);
      }

      // Persisted triggers protect direct SQLite writers, including bundled
      // skills running in their own process. Completion history may be moved
      // from done to archived, but no terminal row may look active.
      this.db.exec(`
        DROP TRIGGER IF EXISTS trg_scheduled_items_state_guard_insert;
        DROP TRIGGER IF EXISTS trg_scheduled_items_state_guard_update;

        CREATE TRIGGER trg_scheduled_items_state_guard_insert
        BEFORE INSERT ON scheduled_items
        WHEN CASE NEW.status
          WHEN 'pending' THEN COALESCE(NEW.board_status, '') NOT IN ('inbox', 'backlog', 'scheduled', 'waiting')
          WHEN 'processing' THEN COALESCE(NEW.board_status, '') != 'in_progress'
          WHEN 'blocked' THEN COALESCE(NEW.board_status, '') != 'waiting'
          WHEN 'fired' THEN COALESCE(NEW.board_status, '') NOT IN ('done', 'archived')
          WHEN 'acted' THEN COALESCE(NEW.board_status, '') NOT IN ('done', 'archived')
          WHEN 'dismissed' THEN COALESCE(NEW.board_status, '') != 'archived'
          WHEN 'expired' THEN COALESCE(NEW.board_status, '') != 'archived'
          WHEN 'failed' THEN COALESCE(NEW.board_status, '') != 'archived'
          ELSE 1
        END
        BEGIN
          SELECT RAISE(ABORT, 'scheduled_items status/board_status invariant violation');
        END;

        CREATE TRIGGER trg_scheduled_items_state_guard_update
        BEFORE UPDATE OF status, board_status ON scheduled_items
        WHEN CASE NEW.status
          WHEN 'pending' THEN COALESCE(NEW.board_status, '') NOT IN ('inbox', 'backlog', 'scheduled', 'waiting')
          WHEN 'processing' THEN COALESCE(NEW.board_status, '') != 'in_progress'
          WHEN 'blocked' THEN COALESCE(NEW.board_status, '') != 'waiting'
          WHEN 'fired' THEN COALESCE(NEW.board_status, '') NOT IN ('done', 'archived')
          WHEN 'acted' THEN COALESCE(NEW.board_status, '') NOT IN ('done', 'archived')
          WHEN 'dismissed' THEN COALESCE(NEW.board_status, '') != 'archived'
          WHEN 'expired' THEN COALESCE(NEW.board_status, '') != 'archived'
          WHEN 'failed' THEN COALESCE(NEW.board_status, '') != 'archived'
          ELSE 1
        END
        BEGIN
          SELECT RAISE(ABORT, 'scheduled_items status/board_status invariant violation');
        END;
      `);
    });

    migrate.immediate();
  }

  /**
   * Pause legacy recurring work whose explicit cadence label disagrees with
   * its machine schedule. The original row is retained in an append-only audit.
   */
  private migrateQuarantineRecurringCadenceMismatches(): void {
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_cadence_quarantine (
          item_id TEXT PRIMARY KEY,
          item_snapshot TEXT NOT NULL,
          reason TEXT NOT NULL,
          quarantined_at INTEGER NOT NULL
        )
      `);
      const rows = this.db.prepare(`
        SELECT * FROM scheduled_items
        WHERE status = 'pending' AND recurring IS NOT NULL AND json_valid(recurring)
          AND (
            (lower(ltrim(message)) LIKE 'daily %' AND json_extract(recurring, '$.type') != 'daily')
            OR (lower(ltrim(message)) LIKE 'weekly %' AND json_extract(recurring, '$.type') != 'weekly')
            OR (lower(ltrim(message)) LIKE 'monthly %' AND json_extract(recurring, '$.type') != 'monthly')
          )
          AND NOT EXISTS (
            SELECT 1 FROM scheduled_cadence_quarantine q WHERE q.item_id = scheduled_items.id
          )
      `).all() as Record<string, unknown>[];
      const audit = this.db.prepare(`
        INSERT INTO scheduled_cadence_quarantine
          (item_id, item_snapshot, reason, quarantined_at)
        VALUES (?, ?, 'recurrence_label_mismatch', ?)
      `);
      const pause = this.db.prepare(`
        UPDATE scheduled_items
        SET status = 'blocked', board_status = 'waiting',
            result = ?, last_error = 'Paused: recurrence label does not match stored cadence',
            updated_at = ?
        WHERE id = ? AND status = 'pending'
      `);
      const now = Date.now();
      for (const row of rows) {
        audit.run(String(row.id), JSON.stringify(row), now);
        pause.run(JSON.stringify({
          response: 'Paused because the recurrence label and stored schedule disagree.',
          completedAt: now,
          taskComplete: false,
          outcome: 'blocked',
          failureCode: 'schedule_cadence_mismatch',
        } satisfies BoardItemResult), now, row.id);
      }
    });
    migrate.immediate();
  }

  /**
   * A pending task title describes work to perform. Legacy rows occasionally
   * stored a fabricated completion sentence there, even though task_config.goal
   * still described unfinished work. Preserve the original row in an audit and
   * restore the executable goal as the neutral board title.
   */
  private migrateReconcilePrematureTaskCompletionMessages(): void {
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_task_intent_reconciliation_audit (
          item_id TEXT PRIMARY KEY,
          item_snapshot TEXT NOT NULL,
          reason TEXT NOT NULL,
          reconciled_at INTEGER NOT NULL
        )
      `);
      const rows = this.db.prepare(`
        SELECT * FROM scheduled_items
        WHERE kind = 'task' AND status = 'pending'
          AND task_config IS NOT NULL AND json_valid(task_config)
          AND NOT EXISTS (
            SELECT 1 FROM scheduled_task_intent_reconciliation_audit audit
            WHERE audit.item_id = scheduled_items.id
          )
      `).all() as Record<string, unknown>[];
      const audit = this.db.prepare(`
        INSERT INTO scheduled_task_intent_reconciliation_audit
          (item_id, item_snapshot, reason, reconciled_at)
        VALUES (?, ?, 'premature_completion_message_replaced_with_task_goal', ?)
      `);
      const update = this.db.prepare(`
        UPDATE scheduled_items
        SET message = ?, message_provenance = 'generated', updated_at = ?
        WHERE id = ? AND kind = 'task' AND status = 'pending'
      `);
      const now = Date.now();
      for (const row of rows) {
        let config: TaskConfig;
        try {
          config = JSON.parse(String(row.task_config)) as TaskConfig;
        } catch {
          continue;
        }
        const normalized = normalizePendingTaskMessage(String(row.message), 'task', config);
        if (normalized === row.message) continue;
        audit.run(String(row.id), JSON.stringify(row), now);
        update.run(normalized, now, row.id);
      }
    });
    migrate.immediate();
  }

  /**
   * Historical factual task results without runtime-issued evidence cannot be
   * trusted as completed. Preserve the full original row, quarantine only
   * demonstrably factual or explicitly evidence-gated work, and reopen any
   * goal it incorrectly completed. Ambiguous tool-using tasks are audited but
   * deliberately left untouched; declaring a tool is not proof that a task
   * made a factual claim.
   */
  private migrateQuarantineUnverifiedTaskResults(): void {
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_task_evidence_quarantine (
          item_id TEXT PRIMARY KEY,
          item_snapshot TEXT NOT NULL,
          reason TEXT NOT NULL,
          quarantined_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS scheduled_task_evidence_audit (
          item_id TEXT PRIMARY KEY,
          item_snapshot TEXT NOT NULL,
          classification TEXT NOT NULL,
          decision TEXT NOT NULL,
          reason TEXT NOT NULL,
          audited_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_scheduled_task_evidence_audit_decision
          ON scheduled_task_evidence_audit(decision, audited_at DESC)
      `);
      const rows = this.db.prepare(`
        SELECT * FROM scheduled_items
        WHERE kind = 'task' AND status IN ('fired', 'acted')
          AND task_config IS NOT NULL AND json_valid(task_config)
          AND result IS NOT NULL AND json_valid(result)
          AND NOT EXISTS (
            SELECT 1 FROM scheduled_task_evidence_quarantine q WHERE q.item_id = scheduled_items.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM scheduled_task_evidence_audit a WHERE a.item_id = scheduled_items.id
          )
      `).all() as Record<string, unknown>[];
      const quarantineAudit = this.db.prepare(`
        INSERT INTO scheduled_task_evidence_quarantine
          (item_id, item_snapshot, reason, quarantined_at)
        VALUES (?, ?, 'missing_runtime_evidence', ?)
      `);
      const evidenceAudit = this.db.prepare(`
        INSERT INTO scheduled_task_evidence_audit
          (item_id, item_snapshot, classification, decision, reason, audited_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const quarantine = this.db.prepare(`
        UPDATE scheduled_items
        SET status = 'failed', board_status = 'archived',
            result = json_set(result,
              '$.outcome', 'failed',
              '$.taskComplete', json('false'),
              '$.failureCode', 'missing_runtime_evidence'
            ),
            last_error = 'Quarantined: historical factual result has no runtime evidence',
            updated_at = ?
        WHERE id = ?
      `);
      const reopenGoal = this.db.prepare(`
        UPDATE memories
        SET metadata = json_remove(
              json_set(metadata, '$.status', 'active', '$.progress', 0),
              '$.completedAt'
            ),
            is_latest = 1, memory_type = 'static_profile', prominence = 1.0,
            updated_at = ?
        WHERE id = ? AND metadata IS NOT NULL AND json_valid(metadata)
          AND json_extract(metadata, '$.goalType') IN ('goal', 'milestone', 'task')
          AND json_extract(metadata, '$.status') = 'completed'
      `);
      const now = Date.now();
      const affectedGoalIds = new Set<string>();
      for (const row of rows) {
        let config: TaskConfig;
        let result: BoardItemResult;
        try {
          config = JSON.parse(String(row.task_config)) as TaskConfig;
          result = JSON.parse(String(row.result)) as BoardItemResult;
        } catch {
          continue;
        }
        if (result.outcome === 'failed' || result.outcome === 'blocked' || result.taskComplete === false) {
          continue;
        }

        const configuredTools = Array.isArray(config.tools)
          ? [...new Set(config.tools.filter(tool => typeof tool === 'string' && tool.trim()))]
          : [];
        const explicitlyRequired = Array.isArray(config.requiredEvidenceTools)
          ? [...new Set(config.requiredEvidenceTools.filter(tool => typeof tool === 'string' && tool.trim()))]
          : [];
        const taskText = `${config.goal ?? ''} ${String(row.message ?? '')}`;
        const explicitPolicy = config.evidencePolicy === 'tool_receipts';
        const factual = LEGACY_FACTUAL_TASK_RE.test(taskText);
        const configuredSources = factual
          ? configuredTools.filter(tool => (
              !NON_EVIDENCE_SOURCE_TOOLS.has(tool)
              && !NEVER_AUTHORITATIVE_EVIDENCE_TOOLS.has(tool.toLowerCase())
            ))
          : configuredTools.filter(tool => !NEVER_AUTHORITATIVE_EVIDENCE_TOOLS.has(tool.toLowerCase()));
        const receipts = Array.isArray(result.evidenceReceipts)
          ? result.evidenceReceipts.filter(isValidRuntimeEvidenceReceipt)
          : [];
        const relevantReceipts = explicitlyRequired.length > 0
          ? receipts.filter(receipt => explicitlyRequired.includes(receipt.toolName))
          : receipts.filter(receipt => configuredSources.includes(receipt.toolName));
        const hasVerifiedEvidence = explicitlyRequired.length > 0
          ? explicitlyRequired.every(tool => receipts.some(receipt => receipt.toolName === tool))
          : configuredSources.some(tool => receipts.some(receipt => receipt.toolName === tool));
        const responseGrounding = hasVerifiedEvidence
          ? verifyResponseEvidenceClaims(result.response ?? '', relevantReceipts)
          : { passed: false, reason: 'Missing configured-source receipt' };
        if (hasVerifiedEvidence && responseGrounding.passed) continue;

        const ambiguousToolTask = configuredTools.length > 0 && !explicitPolicy && !factual;
        if (!explicitPolicy && !factual && !ambiguousToolTask) continue;

        const snapshot = JSON.stringify(row);
        const classification = explicitPolicy
          ? 'explicit_evidence_policy'
          : factual
            ? 'factual_task'
            : 'ambiguous_tool_task';
        if (ambiguousToolTask) {
          evidenceAudit.run(
            String(row.id),
            snapshot,
            classification,
            'audit_only',
            'Missing configured-source receipts; factuality is ambiguous, so state was preserved',
            now,
          );
          continue;
        }

        evidenceAudit.run(
          String(row.id),
          snapshot,
          classification,
          'quarantined',
          configuredSources.length === 0 && explicitlyRequired.length === 0
            ? 'Factual result had no configured evidence source'
            : hasVerifiedEvidence && !responseGrounding.passed
              ? 'Factual result contained claims absent from its evidence ledger'
            : `Missing runtime receipt(s) from configured source(s): ${(
              explicitlyRequired.length > 0 ? explicitlyRequired : configuredSources
            ).join(', ')}`,
          now,
        );
        quarantineAudit.run(String(row.id), snapshot, now);
        quarantine.run(now, row.id);
        if (row.goal_id) {
          reopenGoal.run(now, row.goal_id);
          affectedGoalIds.add(String(row.goal_id));
        }
      }

      // Repair persisted progress and reopen ancestors that can no longer be
      // 100% complete after quarantining a child result. Scope the repair to
      // those exact hierarchies; ambiguous audit-only rows must cause no state
      // mutation anywhere else in the goal graph.
      if (affectedGoalIds.size === 0) return;
      const affectedJson = JSON.stringify([...affectedGoalIds]);
      this.db.prepare(`
        WITH RECURSIVE affected(id) AS (
          SELECT CAST(value AS TEXT) FROM json_each(?)
          UNION
          SELECT rel.target_id
          FROM memory_relations rel
          JOIN affected child ON child.id = rel.source_id
          WHERE rel.relation_type = 'EXTENDS'
        )
        UPDATE memories AS parent
        SET metadata = json_set(
          parent.metadata,
          '$.progress', COALESCE((
            SELECT ROUND(100.0 * SUM(
              CASE WHEN json_extract(child.metadata, '$.status') = 'completed' THEN 1 ELSE 0 END
            ) / NULLIF(COUNT(*), 0))
            FROM memory_relations rel
            JOIN memories child ON child.id = rel.source_id
            WHERE rel.target_id = parent.id AND rel.relation_type = 'EXTENDS'
          ), json_extract(parent.metadata, '$.progress'), 0)
        )
        WHERE parent.id IN (SELECT id FROM affected)
          AND parent.metadata IS NOT NULL AND json_valid(parent.metadata)
          AND json_extract(parent.metadata, '$.goalType') IN ('goal', 'milestone')
      `).run(affectedJson);
      this.db.prepare(`
        WITH RECURSIVE affected(id) AS (
          SELECT CAST(value AS TEXT) FROM json_each(?)
          UNION
          SELECT rel.target_id
          FROM memory_relations rel
          JOIN affected child ON child.id = rel.source_id
          WHERE rel.relation_type = 'EXTENDS'
        )
        UPDATE memories
        SET metadata = json_remove(json_set(metadata, '$.status', 'active'), '$.completedAt'),
            updated_at = ?
        WHERE id IN (SELECT id FROM affected)
          AND metadata IS NOT NULL AND json_valid(metadata)
          AND json_extract(metadata, '$.goalType') IN ('goal', 'milestone')
          AND json_extract(metadata, '$.status') = 'completed'
          AND COALESCE(json_extract(metadata, '$.progress'), 0) < 100
      `).run(affectedJson, now);
    });
    migrate.immediate();
  }

  /** Make active goal hierarchy records non-decaying and self-healing. */
  private migrateDurableGoalMemories(): void {
    const migrate = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE memories
        SET is_latest = 1, memory_type = 'static_profile', prominence = 1.0
        WHERE metadata IS NOT NULL AND json_valid(metadata)
          AND json_extract(metadata, '$.goalType') IN ('goal', 'milestone', 'task')
          AND COALESCE(json_extract(metadata, '$.status'), 'backlog') != 'completed'
      `).run();
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_active_goal_memory_durability
        AFTER UPDATE OF is_latest, memory_type, prominence, metadata ON memories
        WHEN NEW.metadata IS NOT NULL AND json_valid(NEW.metadata)
          AND json_extract(NEW.metadata, '$.goalType') IN ('goal', 'milestone', 'task')
          AND COALESCE(json_extract(NEW.metadata, '$.status'), 'backlog') != 'completed'
          AND (NEW.is_latest != 1 OR NEW.memory_type != 'static_profile' OR NEW.prominence != 1.0)
        BEGIN
          UPDATE memories
          SET is_latest = 1, memory_type = 'static_profile', prominence = 1.0
          WHERE id = NEW.id;
        END
      `);
    });
    migrate.immediate();
  }

  /**
   * Backfill and enforce the dedicated durable goal registry.
   *
   * This migration is deliberately additive. Existing goal memories remain
   * untouched and searchable, while legacy scheduled references that no
   * longer have a memory row receive clearly-labelled placeholder identities
   * instead of being nulled or discarded.
   */
  private migrateDurableGoalRegistry(): void {
    const now = Date.now();
    const migrate = this.db.transaction(() => {
      // Audit identities that are about to be recovered from legacy memory
      // rows. INSERT OR IGNORE below makes this migration idempotent.
      this.db.prepare(`
        INSERT INTO goal_registry_events (goal_id, action, detail, created_at)
        SELECT m.id, 'backfilled', 'Recovered durable identity from goal memory', ?
        FROM memories m
        WHERE m.metadata IS NOT NULL AND json_valid(m.metadata)
          AND json_extract(m.metadata, '$.goalType') IN ('goal', 'milestone', 'task')
          AND NOT EXISTS (SELECT 1 FROM goal_registry g WHERE g.id = m.id)
      `).run(now);

      this.db.exec(`
        INSERT INTO goal_registry (
          id, user_id, title, goal_type, status, parent_id, metadata,
          is_placeholder, origin, created_at, updated_at, completed_at, deleted_at
        )
        SELECT
          m.id,
          m.user_id,
          m.content,
          json_extract(m.metadata, '$.goalType'),
          CASE json_extract(m.metadata, '$.status')
            WHEN 'active' THEN 'active'
            WHEN 'completed' THEN 'completed'
            ELSE 'backlog'
          END,
          CASE
            WHEN typeof(json_extract(m.metadata, '$.parentId')) = 'text'
              THEN json_extract(m.metadata, '$.parentId')
            ELSE NULL
          END,
          m.metadata,
          0,
          'memory',
          m.created_at,
          m.updated_at,
          CASE
            WHEN json_extract(m.metadata, '$.status') = 'completed'
              AND typeof(json_extract(m.metadata, '$.completedAt')) IN ('integer', 'real')
              THEN json_extract(m.metadata, '$.completedAt')
            ELSE NULL
          END,
          NULL
        FROM memories m
        WHERE m.metadata IS NOT NULL AND json_valid(m.metadata)
          AND json_extract(m.metadata, '$.goalType') IN ('goal', 'milestone', 'task')
        ON CONFLICT(id) DO UPDATE SET
          user_id = excluded.user_id,
          title = excluded.title,
          goal_type = excluded.goal_type,
          status = excluded.status,
          parent_id = excluded.parent_id,
          metadata = excluded.metadata,
          is_placeholder = 0,
          origin = 'memory',
          updated_at = MAX(goal_registry.updated_at, excluded.updated_at),
          completed_at = excluded.completed_at
      `);

      // A child can outlive a parent memory in legacy databases. Preserve the
      // referenced parent ID first so the hierarchy is recoverable and can be
      // repaired later without inventing a replacement ID.
      this.db.prepare(`
        INSERT INTO goal_registry (
          id, user_id, title, goal_type, status, parent_id, metadata,
          is_placeholder, origin, created_at, updated_at, completed_at, deleted_at
        )
        SELECT
          json_extract(child.metadata, '$.parentId'),
          child.user_id,
          '[Recovered goal ' || json_extract(child.metadata, '$.parentId') || ']',
          CASE json_extract(child.metadata, '$.goalType')
            WHEN 'task' THEN 'milestone' ELSE 'goal' END,
          'active',
          NULL,
          json_object(
            'goalType', CASE json_extract(child.metadata, '$.goalType')
              WHEN 'task' THEN 'milestone' ELSE 'goal' END,
            'status', 'active',
            'registryRecovered', 1,
            'recoveredFrom', 'parent_reference'
          ),
          1,
          'parent_reference',
          ?, ?, NULL, NULL
        FROM memories child
        WHERE child.metadata IS NOT NULL AND json_valid(child.metadata)
          AND json_extract(child.metadata, '$.goalType') IN ('milestone', 'task')
          AND typeof(json_extract(child.metadata, '$.parentId')) = 'text'
          AND length(trim(json_extract(child.metadata, '$.parentId'))) > 0
        GROUP BY json_extract(child.metadata, '$.parentId')
        ON CONFLICT(id) DO NOTHING
      `).run(now, now);

      // Preserve board references whose memory identity was already missing.
      // The board title is the only surviving human-readable label; flag the
      // row as a placeholder so callers never mistake it for reconstructed
      // user-authored goal metadata.
      this.db.prepare(`
        INSERT INTO goal_registry (
          id, user_id, title, goal_type, status, parent_id, metadata,
          is_placeholder, origin, created_at, updated_at, completed_at, deleted_at
        )
        SELECT
          item.goal_id,
          item.user_id,
          CASE WHEN length(trim(item.message)) > 0 THEN item.message
            ELSE '[Recovered goal ' || item.goal_id || ']' END,
          CASE WHEN item.kind = 'task' THEN 'task' ELSE 'goal' END,
          'backlog',
          NULL,
          json_object(
            'goalType', CASE WHEN item.kind = 'task' THEN 'task' ELSE 'goal' END,
            'status', 'backlog',
            'registryRecovered', 1,
            'recoveredFrom', 'scheduled_item_reference'
          ),
          1,
          'scheduled_reference',
          MIN(item.created_at),
          MAX(item.updated_at),
          NULL,
          NULL
        FROM scheduled_items item
        WHERE item.goal_id IS NOT NULL AND length(trim(item.goal_id)) > 0
        GROUP BY item.goal_id
        ON CONFLICT(id) DO NOTHING
      `).run();

      this.db.prepare(`
        INSERT INTO goal_registry_events (goal_id, action, detail, created_at)
        SELECT g.id, 'placeholder_created',
          CASE g.origin
            WHEN 'parent_reference' THEN 'Recovered missing parent identity'
            ELSE 'Recovered dangling scheduled-item goal reference' END,
          ?
        FROM goal_registry g
        WHERE g.is_placeholder = 1
          AND NOT EXISTS (
            SELECT 1 FROM goal_registry_events e
            WHERE e.goal_id = g.id AND e.action = 'placeholder_created'
          )
      `).run(now);

      // Recreate triggers on every startup so public databases converge to
      // the current invariant even if an older release installed a weaker
      // version.
      this.db.exec(`
        DROP TRIGGER IF EXISTS trg_goal_registry_memory_insert;
        DROP TRIGGER IF EXISTS trg_goal_registry_memory_update;
        DROP TRIGGER IF EXISTS trg_goal_memory_insert_durability;
        DROP TRIGGER IF EXISTS trg_scheduled_goal_reference_insert;
        DROP TRIGGER IF EXISTS trg_scheduled_goal_reference_update;

        CREATE TRIGGER trg_goal_registry_memory_insert
        AFTER INSERT ON memories
        WHEN NEW.metadata IS NOT NULL AND json_valid(NEW.metadata)
          AND json_extract(NEW.metadata, '$.goalType') IN ('goal', 'milestone', 'task')
        BEGIN
          INSERT INTO goal_registry (
            id, user_id, title, goal_type, status, parent_id, metadata,
            is_placeholder, origin, created_at, updated_at, completed_at, deleted_at
          ) VALUES (
            NEW.id,
            NEW.user_id,
            NEW.content,
            json_extract(NEW.metadata, '$.goalType'),
            CASE json_extract(NEW.metadata, '$.status')
              WHEN 'active' THEN 'active'
              WHEN 'completed' THEN 'completed'
              ELSE 'backlog' END,
            CASE WHEN typeof(json_extract(NEW.metadata, '$.parentId')) = 'text'
              THEN json_extract(NEW.metadata, '$.parentId') ELSE NULL END,
            NEW.metadata,
            0,
            'memory',
            NEW.created_at,
            NEW.updated_at,
            CASE WHEN json_extract(NEW.metadata, '$.status') = 'completed'
              AND typeof(json_extract(NEW.metadata, '$.completedAt')) IN ('integer', 'real')
              THEN json_extract(NEW.metadata, '$.completedAt') ELSE NULL END,
            NULL
          )
          ON CONFLICT(id) DO UPDATE SET
            user_id = excluded.user_id,
            title = excluded.title,
            goal_type = excluded.goal_type,
            status = excluded.status,
            parent_id = excluded.parent_id,
            metadata = excluded.metadata,
            is_placeholder = 0,
            origin = 'memory',
            updated_at = excluded.updated_at,
            completed_at = excluded.completed_at;
        END;

        CREATE TRIGGER trg_goal_registry_memory_update
        AFTER UPDATE OF user_id, content, metadata ON memories
        WHEN NEW.metadata IS NOT NULL AND json_valid(NEW.metadata)
          AND json_extract(NEW.metadata, '$.goalType') IN ('goal', 'milestone', 'task')
        BEGIN
          INSERT INTO goal_registry (
            id, user_id, title, goal_type, status, parent_id, metadata,
            is_placeholder, origin, created_at, updated_at, completed_at, deleted_at
          ) VALUES (
            NEW.id,
            NEW.user_id,
            NEW.content,
            json_extract(NEW.metadata, '$.goalType'),
            CASE json_extract(NEW.metadata, '$.status')
              WHEN 'active' THEN 'active'
              WHEN 'completed' THEN 'completed'
              ELSE 'backlog' END,
            CASE WHEN typeof(json_extract(NEW.metadata, '$.parentId')) = 'text'
              THEN json_extract(NEW.metadata, '$.parentId') ELSE NULL END,
            NEW.metadata,
            0,
            'memory',
            NEW.created_at,
            NEW.updated_at,
            CASE WHEN json_extract(NEW.metadata, '$.status') = 'completed'
              AND typeof(json_extract(NEW.metadata, '$.completedAt')) IN ('integer', 'real')
              THEN json_extract(NEW.metadata, '$.completedAt') ELSE NULL END,
            NULL
          )
          ON CONFLICT(id) DO UPDATE SET
            user_id = excluded.user_id,
            title = excluded.title,
            goal_type = excluded.goal_type,
            status = excluded.status,
            parent_id = excluded.parent_id,
            metadata = excluded.metadata,
            is_placeholder = 0,
            origin = 'memory',
            updated_at = excluded.updated_at,
            completed_at = excluded.completed_at;
        END;

        CREATE TRIGGER trg_goal_memory_insert_durability
        AFTER INSERT ON memories
        WHEN NEW.metadata IS NOT NULL AND json_valid(NEW.metadata)
          AND json_extract(NEW.metadata, '$.goalType') IN ('goal', 'milestone', 'task')
          AND COALESCE(json_extract(NEW.metadata, '$.status'), 'backlog') != 'completed'
          AND (NEW.is_latest != 1 OR NEW.memory_type != 'static_profile' OR NEW.prominence != 1.0)
        BEGIN
          UPDATE memories
          SET is_latest = 1, memory_type = 'static_profile', prominence = 1.0
          WHERE id = NEW.id;
        END;

        CREATE TRIGGER trg_scheduled_goal_reference_insert
        BEFORE INSERT ON scheduled_items
        WHEN NEW.goal_id IS NOT NULL
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM goal_registry g
            WHERE g.id = NEW.goal_id AND g.user_id = NEW.user_id AND g.deleted_at IS NULL
          ) THEN RAISE(ABORT, 'scheduled_items.goal_id must reference a live same-owner goal registry row') END;
        END;

        CREATE TRIGGER trg_scheduled_goal_reference_update
        BEFORE UPDATE OF goal_id, user_id ON scheduled_items
        WHEN NEW.goal_id IS NOT NULL
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM goal_registry g
            WHERE g.id = NEW.goal_id AND g.user_id = NEW.user_id AND g.deleted_at IS NULL
          ) THEN RAISE(ABORT, 'scheduled_items.goal_id must reference a live same-owner goal registry row') END;
        END;
      `);
    });

    try {
      migrate.immediate();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`[migration] migrateDurableGoalRegistry failed: ${detail}`, { cause: error });
    }
  }

  /**
   * Apply a runtime-required scheduled_items column group atomically. Required
   * schema migrations intentionally abort startup: continuing after a failed
   * ALTER would expose application code to a partially upgraded table.
   */
  private runRequiredScheduledItemsMigration(
    name: string,
    requiredColumns: ReadonlyArray<readonly [name: string, definition: string]>,
    finalize?: () => void,
    validate?: (columns: ReadonlyMap<string, SqliteTableColumn>) => void,
  ): void {
    const migrate = this.db.transaction(() => {
      const before = this.getScheduledItemColumns();
      for (const [column, definition] of requiredColumns) {
        if (!before.has(column)) {
          this.db.exec(`ALTER TABLE scheduled_items ADD COLUMN ${column} ${definition}`);
        }
      }

      finalize?.();

      const after = this.getScheduledItemColumns();
      const missing = requiredColumns
        .map(([column]) => column)
        .filter(column => !after.has(column));
      if (missing.length > 0) {
        throw new Error(`scheduled_items is missing required column(s): ${missing.join(', ')}`);
      }
      validate?.(after);
    });

    try {
      migrate();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`[migration] ${name} failed: ${detail}`, { cause: error });
    }
  }

  private getScheduledItemColumns(): ReadonlyMap<string, SqliteTableColumn> {
    const rows = this.db.prepare('PRAGMA table_info(scheduled_items)').all() as SqliteTableColumn[];
    return new Map(rows.map(column => [column.name, column]));
  }

  /**
   * Create FTS5 virtual table for transcript chunk full-text search
   */
  private migrateCreateTranscriptFTS(): void {
    try {
      // FTS5 content table for BM25 keyword search over transcript chunks
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS transcript_chunks_fts
        USING fts5(content, content_rowid='rowid');
      `);
    } catch (error) {
      if (error instanceof Error) {
        console.warn(`[migration] migrateCreateTranscriptFTS: ${error.message}`);
      }
    }
  }

  private migrateAddLlmTraceMetadataColumns(): void {
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(llm_traces)").all() as Array<{ name: string }>;
      const columns = new Set(tableInfo.map((c) => c.name));
      const additions: Array<[string, string]> = [
        ['stop_reason', 'TEXT'],
        ['request_max_tokens', 'INTEGER'],
        ['model_context_window_tokens', 'INTEGER'],
        ['model_max_output_tokens', 'INTEGER'],
      ];
      for (const [column, type] of additions) {
        if (!columns.has(column)) {
          this.db.exec(`ALTER TABLE llm_traces ADD COLUMN ${column} ${type}`);
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        console.warn(`[migration] migrateAddLlmTraceMetadataColumns: ${error.message}`);
      }
    }
  }

  // ============ Memory CRUD Operations ============

  /**
   * Add a new memory
   */
  addMemory(memory: Omit<ScallopMemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): ScallopMemoryEntry {
    const id = nanoid();
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO memories (
        id, user_id, content, category, memory_type, importance, confidence, is_latest,
        source, document_date, event_date, prominence, last_accessed, access_count,
        source_chunk, embedding, metadata, learned_from, times_confirmed, contradiction_ids,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?
      )
    `);

    stmt.run(
      id,
      memory.userId,
      memory.content,
      memory.category,
      memory.memoryType,
      memory.importance,
      memory.confidence,
      memory.isLatest ? 1 : 0,
      memory.source || 'user',
      memory.documentDate,
      memory.eventDate,
      memory.prominence,
      memory.lastAccessed,
      memory.accessCount,
      memory.sourceChunk,
      memory.embedding ? JSON.stringify(memory.embedding) : null,
      memory.metadata ? JSON.stringify(memory.metadata) : null,
      memory.learnedFrom || 'conversation',
      memory.timesConfirmed || 1,
      memory.contradictionIds ? JSON.stringify(memory.contradictionIds) : null,
      now,
      now
    );

    if (memory.embedding) {
      this.replaceEmbeddingLsh(id, memory.userId, memory.embedding);
    }

    return { ...memory, id, createdAt: now, updatedAt: now };
  }

  /**
   * Get a memory by ID
   */
  getMemory(id: string): ScallopMemoryEntry | null {
    const stmt = this.db.prepare('SELECT * FROM memories WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToMemory(row) : null;
  }

  /** Read a durable goal identity, including an explicit deletion tombstone. */
  getGoalRegistryEntry(id: string): GoalRegistryEntry | null {
    const row = this.db.prepare('SELECT * FROM goal_registry WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(String(row.metadata ?? '{}')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      // Schema constraints guarantee a text value, but fail safely if a legacy
      // process wrote malformed JSON before the registry triggers existed.
    }
    return {
      id: String(row.id),
      userId: String(row.user_id),
      title: String(row.title),
      goalType: row.goal_type as GoalRegistryEntry['goalType'],
      status: row.status as GoalRegistryEntry['status'],
      parentId: row.parent_id === null ? null : String(row.parent_id),
      metadata,
      isPlaceholder: row.is_placeholder === 1,
      origin: row.origin as GoalRegistryEntry['origin'],
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
      deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
    };
  }

  /** Registry identities remain queryable after completion or deletion. */
  getGoalRegistryEntriesByUser(
    userId: string,
    options: { includeDeleted?: boolean } = {},
  ): GoalRegistryEntry[] {
    const rows = this.db.prepare(`
      SELECT id FROM goal_registry
      WHERE user_id = ? ${options.includeDeleted ? '' : 'AND deleted_at IS NULL'}
      ORDER BY updated_at DESC, id
    `).all(userId) as Array<{ id: string }>;
    return rows
      .map(row => this.getGoalRegistryEntry(row.id))
      .filter((entry): entry is GoalRegistryEntry => entry !== null);
  }

  /**
   * Rebuild a missing searchable memory projection from the durable registry.
   * Returns null for an explicitly-deleted identity or an unrecoverable ID
   * collision. Parent projections/relations are restored first when possible.
   */
  restoreGoalMemoryFromRegistry(id: string, restoring: Set<string> = new Set()): ScallopMemoryEntry | null {
    const existing = this.getMemory(id);
    const registry = this.getGoalRegistryEntry(id);
    if (!registry || registry.deletedAt !== null || restoring.has(id)) return null;
    const existingGoalType = existing?.metadata?.goalType;
    if (existing && (
      existingGoalType === 'goal' || existingGoalType === 'milestone' || existingGoalType === 'task'
    )) return existing;

    restoring.add(id);
    try {
      if (registry.parentId) {
        this.restoreGoalMemoryFromRegistry(registry.parentId, restoring);
      }

      const metadata: Record<string, unknown> = {
        ...registry.metadata,
        goalType: registry.goalType,
        status: registry.status,
        ...(registry.parentId ? { parentId: registry.parentId } : {}),
        ...(registry.completedAt !== null ? { completedAt: registry.completedAt } : {}),
      };
      const dueDate = typeof metadata.dueDate === 'number' && Number.isFinite(metadata.dueDate)
        ? metadata.dueDate
        : null;
      const importance = registry.goalType === 'goal' ? 8 : registry.goalType === 'milestone' ? 7 : 6;

      if (existing) {
        // A generic-memory writer may have overwritten goal metadata while
        // retaining the row ID. Registry identity wins, but the row itself is
        // repaired in place so relations and timestamps are not discarded.
        this.db.prepare(`
          UPDATE memories
          SET user_id = ?, content = ?, category = 'insight',
              memory_type = 'static_profile', importance = ?, confidence = 1.0,
              is_latest = 1, event_date = ?, prominence = 1.0,
              metadata = ?, updated_at = ?
          WHERE id = ?
        `).run(
          registry.userId,
          registry.title,
          importance,
          dueDate,
          JSON.stringify(metadata),
          Date.now(),
          registry.id,
        );
      } else {
        this.db.prepare(`
          INSERT OR IGNORE INTO memories (
            id, user_id, content, category, memory_type, importance, confidence,
            is_latest, source, document_date, event_date, prominence,
            last_accessed, access_count, source_chunk, embedding, metadata,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'insight', 'static_profile', ?, 1.0,
            1, 'user', ?, ?, 1.0, NULL, 0, NULL, NULL, ?, ?, ?)
        `).run(
          registry.id,
          registry.userId,
          registry.title,
          importance,
          registry.createdAt,
          dueDate,
          JSON.stringify(metadata),
          registry.createdAt,
          Date.now(),
        );
      }

      const restored = this.getMemory(id);
      if (!restored) return null;

      if (registry.parentId && this.getMemory(registry.parentId)) {
        this.db.prepare(`
          INSERT OR IGNORE INTO memory_relations (
            id, source_id, target_id, relation_type, confidence, created_at
          ) VALUES (?, ?, ?, 'EXTENDS', 1.0, ?)
        `).run(nanoid(), id, registry.parentId, Date.now());
      }

      this.db.prepare(`
        INSERT INTO goal_registry_events (goal_id, action, detail, created_at)
        VALUES (?, 'restored_projection', 'Rebuilt missing searchable memory projection', ?)
      `).run(id, Date.now());
      return restored;
    } finally {
      restoring.delete(id);
    }
  }

  /** Tombstone a goal identity without erasing its status/title/history. */
  markGoalRegistryDeleted(id: string): boolean {
    const now = Date.now();
    const mark = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE goal_registry
        SET deleted_at = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(now, now, id);
      if (result.changes === 0) return false;
      this.db.prepare(`
        INSERT INTO goal_registry_events (goal_id, action, detail, created_at)
        VALUES (?, 'deleted', 'Explicit goal deletion; identity retained as tombstone', ?)
      `).run(id, now);
      return true;
    });
    return mark.immediate();
  }

  /**
   * Keep the public add/update APIs backward-compatible while ensuring every
   * scheduled goal link resolves to a same-owner registry identity. Raw SQL
   * writers are still protected by the fail-closed triggers.
   */
  private ensureScheduledGoalReference(
    goalId: string,
    userId: string,
    title: string,
    kind: ScheduledItemKind,
  ): void {
    const existing = this.getGoalRegistryEntry(goalId);
    if (existing) {
      if (existing.deletedAt !== null) {
        throw new Error(`Cannot link scheduled item to deleted goal ${goalId}`);
      }
      if (existing.userId !== userId) {
        throw new Error(`Cannot link scheduled item to goal ${goalId} owned by another user`);
      }
      return;
    }

    const memory = this.getMemory(goalId);
    const metadata = memory?.metadata;
    const memoryGoalType = metadata?.goalType;
    const goalType: GoalRegistryEntry['goalType'] =
      memoryGoalType === 'goal' || memoryGoalType === 'milestone' || memoryGoalType === 'task'
        ? memoryGoalType
        : kind === 'task' ? 'task' : 'goal';
    const statusValue = metadata?.status;
    const status: GoalRegistryEntry['status'] =
      statusValue === 'active' || statusValue === 'completed' || statusValue === 'backlog'
        ? statusValue
        : 'backlog';
    const now = Date.now();
    const registryMetadata: Record<string, unknown> = metadata
      ? { ...metadata, goalType, status }
      : {
          goalType,
          status,
          registryRecovered: true,
          recoveredFrom: 'scheduled_item_reference',
        };
    this.db.prepare(`
      INSERT INTO goal_registry (
        id, user_id, title, goal_type, status, parent_id, metadata,
        is_placeholder, origin, created_at, updated_at, completed_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      goalId,
      userId,
      memory?.content ?? (title || `[Recovered goal ${goalId}]`),
      goalType,
      status,
      typeof registryMetadata.parentId === 'string' ? registryMetadata.parentId : null,
      JSON.stringify(registryMetadata),
      memory ? 0 : 1,
      memory ? 'memory' : 'scheduled_reference',
      memory?.createdAt ?? now,
      memory?.updatedAt ?? now,
      status === 'completed' && typeof registryMetadata.completedAt === 'number'
        ? registryMetadata.completedAt
        : null,
    );
    this.db.prepare(`
      INSERT INTO goal_registry_events (goal_id, action, detail, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      goalId,
      memory ? 'backfilled' : 'placeholder_created',
      memory ? 'Registered goal while creating scheduled reference' : 'Registered unresolved scheduled reference',
      now,
    );
  }

  /** Goal hierarchy records bypass ordinary-memory latest/decay filtering. */
  getGoalMemoriesByUser(userId: string): ScallopMemoryEntry[] {
    // Self-heal any projection removed by ordinary-memory cleanup. Explicit
    // deletion tombstones are excluded and therefore never resurrected.
    const durableIds = this.db.prepare(`
      SELECT id FROM goal_registry WHERE user_id = ? AND deleted_at IS NULL
    `).all(userId) as Array<{ id: string }>;
    for (const { id } of durableIds) {
      this.restoreGoalMemoryFromRegistry(id);
    }
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE user_id = ? AND metadata IS NOT NULL AND json_valid(metadata)
        AND json_extract(metadata, '$.goalType') IN ('goal', 'milestone', 'task')
      ORDER BY
        CASE json_extract(metadata, '$.status')
          WHEN 'active' THEN 0 WHEN 'backlog' THEN 1 ELSE 2 END,
        document_date DESC
    `).all(userId) as Record<string, unknown>[];
    return rows.map(row => this.rowToMemory(row));
  }

  /** Remove dangling board references before an explicit goal deletion. */
  unlinkScheduledItemsFromGoal(goalId: string): number {
    const result = this.db.prepare(`
      UPDATE scheduled_items
      SET goal_id = NULL,
          source_memory_id = CASE WHEN source_memory_id = ? THEN NULL ELSE source_memory_id END,
          updated_at = ?
      WHERE goal_id = ? OR source_memory_id = ?
    `).run(goalId, Date.now(), goalId, goalId);
    return result.changes;
  }

  /**
   * Update a memory
   */
  updateMemory(id: string, updates: Partial<ScallopMemoryEntry>): boolean {
    const memory = this.getMemory(id);
    if (!memory) return false;

    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE memories SET
        content = COALESCE(?, content),
        category = COALESCE(?, category),
        memory_type = COALESCE(?, memory_type),
        importance = COALESCE(?, importance),
        confidence = COALESCE(?, confidence),
        is_latest = COALESCE(?, is_latest),
        event_date = COALESCE(?, event_date),
        prominence = COALESCE(?, prominence),
        last_accessed = COALESCE(?, last_accessed),
        access_count = COALESCE(?, access_count),
        source_chunk = COALESCE(?, source_chunk),
        embedding = COALESCE(?, embedding),
        metadata = COALESCE(?, metadata),
        updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      updates.content ?? null,
      updates.category ?? null,
      updates.memoryType ?? null,
      updates.importance ?? null,
      updates.confidence ?? null,
      updates.isLatest !== undefined ? (updates.isLatest ? 1 : 0) : null,
      updates.eventDate ?? null,
      updates.prominence ?? null,
      updates.lastAccessed ?? null,
      updates.accessCount ?? null,
      updates.sourceChunk ?? null,
      updates.embedding ? JSON.stringify(updates.embedding) : null,
      updates.metadata ? JSON.stringify(updates.metadata) : null,
      now,
      id
    );

    if (updates.embedding) {
      this.replaceEmbeddingLsh(id, memory.userId, updates.embedding);
    }

    return true;
  }

  /**
   * Delete a memory
   */
  deleteMemory(id: string): boolean {
    this.db.prepare('DELETE FROM memory_embedding_lsh WHERE memory_id = ?').run(id);
    const stmt = this.db.prepare('DELETE FROM memories WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Get memories by user ID
   */
  getMemoriesByUser(
    userId: string,
    options: {
      category?: MemoryCategory;
      memoryType?: ScallopMemoryType;
      minProminence?: number;
      isLatest?: boolean;
      limit?: number;
      offset?: number;
      /** If true, include all sources. Default: false (exclude skill outputs and long assistant responses). */
      includeAllSources?: boolean;
    } = {}
  ): ScallopMemoryEntry[] {
    let query = 'SELECT * FROM memories WHERE user_id = ?';
    const params: unknown[] = [userId];

    // By default, only include user-extracted facts (exclude skill outputs, assistant responses, system entries)
    if (!options.includeAllSources) {
      query += " AND source = 'user'";
    }

    if (options.category) {
      query += ' AND category = ?';
      params.push(options.category);
    }
    if (options.memoryType) {
      query += ' AND memory_type = ?';
      params.push(options.memoryType);
    }
    if (options.minProminence !== undefined) {
      query += ' AND prominence >= ?';
      params.push(options.minProminence);
    }
    // Default to is_latest=1 so superseded rows don't leak into normal retrieval.
    // Callers that need superseded rows (decay, cleanup) pass isLatest: false.
    if (options.isLatest !== undefined) {
      query += ' AND is_latest = ?';
      params.push(options.isLatest ? 1 : 0);
    } else {
      query += ' AND is_latest = 1';
    }

    query += ' ORDER BY prominence DESC, document_date DESC';

    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToMemory(row));
  }

  /**
   * Get memories stored within a recent time window (short-term memory buffer).
   * Returns memories ordered by recency (newest first).
   */
  getRecentMemories(
    userId: string,
    windowMs: number,
    options: { isLatest?: boolean } = {}
  ): ScallopMemoryEntry[] {
    const cutoff = Date.now() - windowMs;
    let query = 'SELECT * FROM memories WHERE user_id = ? AND document_date >= ?';
    const params: unknown[] = [userId, cutoff];

    if (options.isLatest !== undefined) {
      query += ' AND is_latest = ?';
      params.push(options.isLatest ? 1 : 0);
    } else {
      query += ' AND is_latest = 1';
    }

    query += ' ORDER BY document_date DESC';

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToMemory(row));
  }

  /**
   * Get all memories
   */
  getAllMemories(options: { limit?: number; minProminence?: number } = {}): ScallopMemoryEntry[] {
    let query = 'SELECT * FROM memories';
    const params: unknown[] = [];

    if (options.minProminence !== undefined) {
      query += ' WHERE prominence >= ?';
      params.push(options.minProminence);
    }

    query += ' ORDER BY prominence DESC';

    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToMemory(row));
  }

  // ============ Light (no-embedding) Memory Queries ============

  /** All columns except `embedding` — avoids loading & JSON-parsing 768-dim vectors */
  private static readonly LIGHT_COLUMNS = [
    'id', 'user_id', 'content', 'category', 'memory_type', 'importance',
    'confidence', 'is_latest', 'source', 'document_date', 'event_date',
    'prominence', 'last_accessed', 'access_count', 'source_chunk',
    'metadata', 'learned_from', 'times_confirmed', 'contradiction_ids',
    'created_at', 'updated_at',
  ].join(', ');

  /** Convert a row (without embedding column) to ScallopMemoryEntryLight */
  private rowToMemoryLight(row: Record<string, unknown>): ScallopMemoryEntryLight {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      content: row.content as string,
      category: row.category as MemoryCategory,
      memoryType: row.memory_type as ScallopMemoryType,
      importance: row.importance as number,
      confidence: row.confidence as number,
      isLatest: (row.is_latest as number) === 1,
      source: (row.source as 'user' | 'assistant') || 'user',
      documentDate: row.document_date as number,
      eventDate: row.event_date as number | null,
      prominence: row.prominence as number,
      lastAccessed: row.last_accessed as number | null,
      accessCount: row.access_count as number,
      sourceChunk: row.source_chunk as string | null,
      embedding: null,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
      learnedFrom: (row.learned_from as string) || 'conversation',
      timesConfirmed: (row.times_confirmed as number) || 1,
      contradictionIds: row.contradiction_ids ? JSON.parse(row.contradiction_ids as string) : null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  /**
   * Light version of getMemoriesByUser — excludes embedding column.
   */
  getMemoriesByUserLight(
    userId: string,
    options: {
      category?: MemoryCategory;
      memoryType?: ScallopMemoryType;
      minProminence?: number;
      isLatest?: boolean;
      limit?: number;
      offset?: number;
      includeAllSources?: boolean;
      /** Prominence is the default; recency means document time, newest first. */
      orderBy?: 'prominence' | 'recency';
    } = {}
  ): ScallopMemoryEntryLight[] {
    let query = `SELECT ${ScallopDatabase.LIGHT_COLUMNS} FROM memories WHERE user_id = ?`;
    const params: unknown[] = [userId];

    if (!options.includeAllSources) {
      query += " AND source = 'user'";
    }
    if (options.category) {
      query += ' AND category = ?';
      params.push(options.category);
    }
    if (options.memoryType) {
      query += ' AND memory_type = ?';
      params.push(options.memoryType);
    }
    if (options.minProminence !== undefined) {
      query += ' AND prominence >= ?';
      params.push(options.minProminence);
    }
    // Default is_latest=1 filter — keeps superseded rows out of retrieval.
    if (options.isLatest !== undefined) {
      query += ' AND is_latest = ?';
      params.push(options.isLatest ? 1 : 0);
    } else {
      query += ' AND is_latest = 1';
    }

    query += options.orderBy === 'recency'
      ? ' ORDER BY document_date DESC, prominence DESC'
      : ' ORDER BY prominence DESC, document_date DESC';

    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToMemoryLight(row));
  }

  /**
   * Light version of getRecentMemories — excludes embedding column.
   */
  getRecentMemoriesLight(
    userId: string,
    windowMs: number,
    options: { isLatest?: boolean } = {}
  ): ScallopMemoryEntryLight[] {
    const cutoff = Date.now() - windowMs;
    let query = `SELECT ${ScallopDatabase.LIGHT_COLUMNS} FROM memories WHERE user_id = ? AND document_date >= ?`;
    const params: unknown[] = [userId, cutoff];

    if (options.isLatest !== undefined) {
      query += ' AND is_latest = ?';
      params.push(options.isLatest ? 1 : 0);
    } else {
      query += ' AND is_latest = 1';
    }

    query += ' ORDER BY document_date DESC';

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToMemoryLight(row));
  }

  /**
   * Light version of getAllMemories — excludes embedding column.
   */
  getAllMemoriesLight(options: { limit?: number; minProminence?: number } = {}): ScallopMemoryEntryLight[] {
    let query = `SELECT ${ScallopDatabase.LIGHT_COLUMNS} FROM memories`;
    const params: unknown[] = [];

    if (options.minProminence !== undefined) {
      query += ' WHERE prominence >= ?';
      params.push(options.minProminence);
    }

    query += ' ORDER BY prominence DESC';

    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToMemoryLight(row));
  }

  /**
   * Load only id + embedding for a set of memory IDs.
   * Returns a Map<id, number[]> (entries without embeddings are omitted).
   */
  getEmbeddingsByIds(ids: string[]): Map<string, number[]> {
    if (ids.length === 0) return new Map();

    const result = new Map<string, number[]>();
    // Stay below SQLite's variable limit. Hybrid retrieval may scan the full
    // filtered corpus to form an independent semantic top-K, which can exceed
    // the old single-query limit on established installations.
    const SQLITE_ID_BATCH_SIZE = 500;
    for (let offset = 0; offset < ids.length; offset += SQLITE_ID_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + SQLITE_ID_BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');
      const stmt = this.db.prepare(
        `SELECT id, embedding FROM memories WHERE id IN (${placeholders})`
      );
      const rows = stmt.all(...batch) as Array<{ id: string; embedding: string | null }>;

      for (const row of rows) {
        if (row.embedding) {
          try {
            const parsed = JSON.parse(row.embedding) as unknown;
            if (Array.isArray(parsed) && parsed.every(value => typeof value === 'number' && Number.isFinite(value))) {
              result.set(row.id, parsed);
            }
          } catch {
            // Isolate a malformed legacy row instead of failing the whole
            // lexical/semantic union query.
          }
        }
      }
    }
    return result;
  }

  /**
   * Return a bounded, indexed set of approximate semantic neighbours.
   * Results with more LSH collisions rank first; exact-bucket collisions have
   * twice the weight of the bounded Hamming-neighbour probes.
   */
  getSemanticCandidateIds(
    queryEmbedding: number[],
    options: SemanticCandidateOptions,
  ): string[] {
    if (
      queryEmbedding.length === 0 ||
      !Number.isFinite(options.maxCandidates) ||
      options.maxCandidates <= 0
    ) return [];

    const probes = buildSemanticLshProbes(queryEmbedding);

    const requestedLimit = Math.min(
      SEMANTIC_CANDIDATE_LIMIT,
      Math.max(1, Math.floor(options.maxCandidates)),
    );

    // ScallopMemoryStore already has a filtered light corpus for BM25. Reuse it
    // when supplied. Direct database callers get the same behavior through one
    // light metadata query, rather than repeating a memories-table join for all
    // 48 LSH probes (the source of the prior 10k-corpus latency regression).
    let eligibleIds = options.eligibleIds;
    let priorities = options.candidatePriorities;
    if (!eligibleIds) {
      let eligibleSql = 'SELECT id, prominence, document_date FROM memories WHERE 1 = 1';
      const eligibleParams: unknown[] = [];
      if (options.userId) {
        eligibleSql += ' AND user_id = ?';
        eligibleParams.push(options.userId);
      }
      if (options.category) {
        eligibleSql += ' AND category = ?';
        eligibleParams.push(options.category);
      }
      if (options.minProminence !== undefined) {
        eligibleSql += ' AND prominence >= ?';
        eligibleParams.push(options.minProminence);
      }
      if (options.isLatest !== undefined) {
        eligibleSql += ' AND is_latest = ?';
        eligibleParams.push(options.isLatest ? 1 : 0);
      }
      if (options.eventDateRange) {
        eligibleSql += ' AND event_date BETWEEN ? AND ?';
        eligibleParams.push(options.eventDateRange.start, options.eventDateRange.end);
      }
      if (options.documentDateRange) {
        eligibleSql += ' AND document_date BETWEEN ? AND ?';
        eligibleParams.push(options.documentDateRange.start, options.documentDateRange.end);
      }
      const eligibleRows = this.db.prepare(eligibleSql).all(...eligibleParams) as Array<{
        id: string;
        prominence: number;
        document_date: number;
      }>;
      eligibleIds = new Set(eligibleRows.map((row) => row.id));
      priorities = new Map(eligibleRows.map((row) => [row.id, {
        prominence: row.prominence,
        documentDate: row.document_date,
      }]));
    }

    // UNION ALL keeps each probe as an explicit integer-index range scan while
    // crossing the JS/native boundary once. A VALUES CTE looks tidier but SQLite
    // materializes a slow nested join for this workload.
    const perProbeLimit = Math.max(64, requestedLimit);
    const userFilter = options.userId ? ' AND user_id = ?' : '';
    const probeSql = `
      SELECT memory_id, ? AS weight
      FROM memory_embedding_lsh INDEXED BY idx_memory_lsh_lookup
      WHERE index_version = ? AND dimension = ? AND table_id = ? AND bucket = ?
        ${userFilter}
      LIMIT ?
    `;
    const lookup = this.db.prepare(
      probes.map(() => `SELECT * FROM (${probeSql})`).join(' UNION ALL '),
    );
    const ranked = new Map<string, {
      score: number;
      prominence: number;
      documentDate: number;
    }>();

    const rows = lookup.all(
      ...probes.flatMap((probe) => [
        probe.weight,
        SEMANTIC_LSH_VERSION,
        queryEmbedding.length,
        probe.tableId,
        probe.bucket,
        ...(options.userId ? [options.userId] : []),
        perProbeLimit,
      ]),
    ) as Array<{ memory_id: string; weight: number }>;
    for (const row of rows) {
      if (!eligibleIds.has(row.memory_id)) continue;
      const existing = ranked.get(row.memory_id);
      if (existing) {
        existing.score += row.weight;
      } else {
        ranked.set(row.memory_id, {
          score: row.weight,
          prominence: priorities?.get(row.memory_id)?.prominence ?? 0,
          documentDate: priorities?.get(row.memory_id)?.documentDate ?? 0,
        });
      }
    }

    return [...ranked]
      .sort(([, a], [, b]) =>
        b.score - a.score ||
        b.prominence - a.prominence ||
        b.documentDate - a.documentDate)
      .slice(0, requestedLimit)
      .map(([id]) => id);
  }

  /**
   * Bump confirmation count and boost confidence/prominence for a re-stated fact.
   */
  reinforceMemory(id: string, confidenceBoost: number = 0.05, prominenceBoost: number = 0.1): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE memories SET
        times_confirmed = times_confirmed + 1,
        confidence = MIN(1.0, confidence + ?),
        prominence = MIN(1.0, prominence + ?),
        updated_at = ?
      WHERE id = ?
    `).run(confidenceBoost, prominenceBoost, now, id);
  }

  /**
   * Add contradiction IDs to a memory.
   */
  addContradiction(memoryId: string, contradictingId: string): void {
    const memory = this.getMemory(memoryId);
    if (!memory) return;

    const existing = memory.contradictionIds || [];
    if (!existing.includes(contradictingId)) {
      existing.push(contradictingId);
      const now = Date.now();
      this.db.prepare(
        'UPDATE memories SET contradiction_ids = ?, updated_at = ? WHERE id = ?'
      ).run(JSON.stringify(existing), now, memoryId);
    }
  }

  /** Record automatic retrieval telemetry without pretending the user reinforced the memory. */
  recordAccess(id: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE memories SET
        last_accessed = ?,
        access_count = access_count + 1
      WHERE id = ?
    `);
    stmt.run(now, id);
  }

  /**
   * Update prominence for all memories (batch)
   */
  updateProminences(updates: Array<{ id: string; prominence: number }>): void {
    // Don't update updated_at — prominence decay is a system maintenance operation,
    // not a user interaction. Preserves updated_at for staleness detection.
    const stmt = this.db.prepare('UPDATE memories SET prominence = ? WHERE id = ?');

    const transaction = this.db.transaction(() => {
      for (const { id, prominence } of updates) {
        stmt.run(prominence, id);
      }
    });

    transaction();
  }

  // ============ Relationship Operations ============

  /**
   * Add a relationship between memories
   */
  addRelation(
    sourceId: string,
    targetId: string,
    relationType: RelationType,
    confidence: number = 0.8
  ): MemoryRelation {
    const id = nanoid();
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO memory_relations (id, source_id, target_id, relation_type, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, sourceId, targetId, relationType, confidence, now);

    // UPDATES relation records the link but keeps both memories searchable.
    // Superseding loses specific details that retrieval needs.

    return { id, sourceId, targetId, relationType, confidence, createdAt: now };
  }

  /**
   * Get relations for a memory (both incoming and outgoing)
   */
  getRelations(memoryId: string): MemoryRelation[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_relations
      WHERE source_id = ? OR target_id = ?
    `);
    const rows = stmt.all(memoryId, memoryId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRelation(row));
  }

  /**
   * Get outgoing relations from a memory
   */
  getOutgoingRelations(memoryId: string, relationType?: RelationType): MemoryRelation[] {
    let query = 'SELECT * FROM memory_relations WHERE source_id = ?';
    const params: unknown[] = [memoryId];

    if (relationType) {
      query += ' AND relation_type = ?';
      params.push(relationType);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRelation(row));
  }

  /**
   * Get incoming relations to a memory
   */
  getIncomingRelations(memoryId: string, relationType?: RelationType): MemoryRelation[] {
    let query = 'SELECT * FROM memory_relations WHERE target_id = ?';
    const params: unknown[] = [memoryId];

    if (relationType) {
      query += ' AND relation_type = ?';
      params.push(relationType);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRelation(row));
  }

  /**
   * Get all relations
   */
  getAllRelations(): MemoryRelation[] {
    const stmt = this.db.prepare('SELECT * FROM memory_relations');
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToRelation(row));
  }

  /**
   * Delete a relation
   */
  deleteRelation(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM memory_relations WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // ============ User Profile Operations ============

  /**
   * Set a static profile value
   */
  setProfileValue(userId: string, key: string, value: string, confidence: number = 0.9): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO user_profiles (user_id, key, value, confidence, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET
        value = excluded.value,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at
    `);
    stmt.run(userId, key, value, confidence, now);
  }

  /**
   * Get a static profile value
   */
  getProfileValue(userId: string, key: string): UserProfileEntry | null {
    const stmt = this.db.prepare('SELECT * FROM user_profiles WHERE user_id = ? AND key = ?');
    const row = stmt.get(userId, key) as Record<string, unknown> | undefined;
    return row ? this.rowToProfileEntry(row) : null;
  }

  /**
   * Get all static profile values for a user
   */
  getProfile(userId: string): UserProfileEntry[] {
    const stmt = this.db.prepare('SELECT * FROM user_profiles WHERE user_id = ?');
    const rows = stmt.all(userId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToProfileEntry(row));
  }

  /**
   * Delete a static profile value
   */
  deleteProfileValue(userId: string, key: string): boolean {
    const stmt = this.db.prepare('DELETE FROM user_profiles WHERE user_id = ? AND key = ?');
    const result = stmt.run(userId, key);
    return result.changes > 0;
  }

  // ============ Dynamic Profile Operations ============

  /**
   * Update dynamic profile
   */
  updateDynamicProfile(userId: string, profile: Partial<Omit<DynamicProfile, 'userId'>>): void {
    const now = Date.now();

    // Check if exists
    const existing = this.db.prepare('SELECT * FROM dynamic_profiles WHERE user_id = ?').get(userId);

    if (existing) {
      const stmt = this.db.prepare(`
        UPDATE dynamic_profiles SET
          recent_topics = COALESCE(?, recent_topics),
          current_mood = COALESCE(?, current_mood),
          active_projects = COALESCE(?, active_projects),
          last_interaction = ?
        WHERE user_id = ?
      `);
      stmt.run(
        profile.recentTopics ? JSON.stringify(profile.recentTopics) : null,
        profile.currentMood ?? null,
        profile.activeProjects ? JSON.stringify(profile.activeProjects) : null,
        now,
        userId
      );
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO dynamic_profiles (user_id, recent_topics, current_mood, active_projects, last_interaction)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(
        userId,
        profile.recentTopics ? JSON.stringify(profile.recentTopics) : '[]',
        profile.currentMood ?? null,
        profile.activeProjects ? JSON.stringify(profile.activeProjects) : '[]',
        now
      );
    }
  }

  /**
   * Get dynamic profile
   */
  getDynamicProfile(userId: string): DynamicProfile | null {
    const stmt = this.db.prepare('SELECT * FROM dynamic_profiles WHERE user_id = ?');
    const row = stmt.get(userId) as Record<string, unknown> | undefined;
    return row ? this.rowToDynamicProfile(row) : null;
  }

  // ============ Behavioral Patterns Operations ============

  /**
   * Update behavioral patterns.
   * Signal fields (messageFrequency, sessionEngagement, topicSwitch, responseLength)
   * are stored inside the response_preferences JSON column to avoid schema migration.
   */
  updateBehavioralPatterns(userId: string, patterns: Partial<Omit<BehavioralPatterns, 'userId' | 'updatedAt'>>): void {
    const now = Date.now();

    // Merge signal fields into responsePreferences JSON for storage
    const responsePrefsToStore: Record<string, unknown> = {
      ...(patterns.responsePreferences ?? {}),
    };
    if (patterns.messageFrequency !== undefined) {
      responsePrefsToStore._sig_messageFrequency = patterns.messageFrequency;
    }
    if (patterns.sessionEngagement !== undefined) {
      responsePrefsToStore._sig_sessionEngagement = patterns.sessionEngagement;
    }
    if (patterns.topicSwitch !== undefined) {
      responsePrefsToStore._sig_topicSwitch = patterns.topicSwitch;
    }
    if (patterns.responseLength !== undefined) {
      responsePrefsToStore._sig_responseLength = patterns.responseLength;
    }
    if (patterns.affectState !== undefined) {
      responsePrefsToStore.affectState = patterns.affectState;
    }
    if (patterns.smoothedAffect !== undefined) {
      responsePrefsToStore.smoothedAffect = patterns.smoothedAffect;
    }

    const existing = this.db.prepare('SELECT * FROM behavioral_patterns WHERE user_id = ?').get(userId) as Record<string, unknown> | undefined;

    if (existing) {
      // Merge signal fields with existing response_preferences
      const existingPrefs: Record<string, unknown> = existing.response_preferences
        ? JSON.parse(existing.response_preferences as string)
        : {};
      const mergedPrefs = { ...existingPrefs, ...responsePrefsToStore };

      const stmt = this.db.prepare(`
        UPDATE behavioral_patterns SET
          communication_style = COALESCE(?, communication_style),
          expertise_areas = COALESCE(?, expertise_areas),
          response_preferences = ?,
          active_hours = COALESCE(?, active_hours),
          updated_at = ?
        WHERE user_id = ?
      `);
      stmt.run(
        patterns.communicationStyle ?? null,
        patterns.expertiseAreas ? JSON.stringify(patterns.expertiseAreas) : null,
        JSON.stringify(mergedPrefs),
        patterns.activeHours ? JSON.stringify(patterns.activeHours) : null,
        now,
        userId
      );
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO behavioral_patterns (user_id, communication_style, expertise_areas, response_preferences, active_hours, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        userId,
        patterns.communicationStyle ?? null,
        patterns.expertiseAreas ? JSON.stringify(patterns.expertiseAreas) : '[]',
        Object.keys(responsePrefsToStore).length > 0 ? JSON.stringify(responsePrefsToStore) : '{}',
        patterns.activeHours ? JSON.stringify(patterns.activeHours) : '[]',
        now
      );
    }
  }

  /**
   * Get behavioral patterns
   */
  getBehavioralPatterns(userId: string): BehavioralPatterns | null {
    const stmt = this.db.prepare('SELECT * FROM behavioral_patterns WHERE user_id = ?');
    const row = stmt.get(userId) as Record<string, unknown> | undefined;
    return row ? this.rowToBehavioralPatterns(row) : null;
  }

  // ============ External Tool Operation Ledger ============

  /**
   * Write the durable intent record before dispatching an external mutation.
   * A known definitive failure may be retried; prepared, uncertain, and
   * successful operations fail closed so restarts cannot duplicate a write.
   */
  reserveToolOperation(input: {
    operationId: string;
    sessionId: string;
    toolName: string;
    callSignature: string;
    userIntentDigest: string;
  }): ToolOperationReservation {
    const reserve = this.db.transaction((): ToolOperationReservation => {
      const existing = this.db.prepare(`
        SELECT status FROM tool_operation_ledger WHERE operation_id = ?
      `).get(input.operationId) as { status: ToolOperationStatus } | undefined;
      const now = Date.now();

      if (!existing) {
        this.db.prepare(`
          INSERT INTO tool_operation_ledger (
            operation_id, session_id, tool_name, call_signature,
            user_intent_digest, status, result_digest,
            attempt_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'prepared', NULL, 1, ?, ?)
        `).run(
          input.operationId,
          input.sessionId,
          input.toolName,
          input.callSignature,
          input.userIntentDigest,
          now,
          now,
        );
        return { reserved: true };
      }

      if (existing.status === 'failed') {
        this.db.prepare(`
          UPDATE tool_operation_ledger
          SET status = 'prepared', result_digest = NULL,
              attempt_count = attempt_count + 1, updated_at = ?
          WHERE operation_id = ? AND status = 'failed'
        `).run(now, input.operationId);
        return { reserved: true };
      }

      return { reserved: false, existingStatus: existing.status };
    });
    return reserve.immediate();
  }

  /** Complete a prepared dispatch. A timeout/abort wins over late completion. */
  completeToolOperation(
    operationId: string,
    status: Exclude<ToolOperationStatus, 'prepared'>,
    resultDigest?: string,
  ): boolean {
    const result = this.db.prepare(`
      UPDATE tool_operation_ledger
      SET status = ?, result_digest = ?, updated_at = ?
      WHERE operation_id = ? AND status = 'prepared'
    `).run(status, resultDigest ?? null, Date.now(), operationId);
    return result.changes === 1;
  }

  /** Test/diagnostic lookup; contains hashes and metadata only. */
  getToolOperation(operationId: string): {
    operationId: string;
    sessionId: string;
    toolName: string;
    callSignature: string;
    userIntentDigest: string;
    status: ToolOperationStatus;
    resultDigest: string | null;
    attemptCount: number;
    createdAt: number;
    updatedAt: number;
  } | null {
    const row = this.db.prepare(`
      SELECT * FROM tool_operation_ledger WHERE operation_id = ?
    `).get(operationId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      operationId: String(row.operation_id),
      sessionId: String(row.session_id),
      toolName: String(row.tool_name),
      callSignature: String(row.call_signature),
      userIntentDigest: String(row.user_intent_digest),
      status: row.status as ToolOperationStatus,
      resultDigest: row.result_digest == null ? null : String(row.result_digest),
      attemptCount: Number(row.attempt_count),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  /** Privacy-safe operation provenance for transcript summarization. */
  getToolOperationsBySession(sessionId: string): ToolOperationLedgerEntry[] {
    const rows = this.db.prepare(`
      SELECT operation_id, session_id, tool_name, status, created_at, updated_at
      FROM tool_operation_ledger
      WHERE session_id = ?
      ORDER BY updated_at, operation_id
    `).all(sessionId) as Record<string, unknown>[];
    return rows.map(row => ({
      operationId: String(row.operation_id),
      sessionId: String(row.session_id),
      toolName: String(row.tool_name),
      status: row.status as ToolOperationStatus,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  /** Record one final brain decision without retaining private content. */
  recordBrainOutcome(input: BrainOutcomeRecordInput): BrainOutcomeRow {
    const row: BrainOutcomeRow = {
      id: input.id ?? randomUUID(),
      brainId: input.brainId,
      userId: input.userId,
      sessionId: input.sessionId ?? null,
      source: input.source,
      kind: input.kind,
      proposalDigest: input.proposalDigest,
      contextDigest: input.contextDigest,
      decision: input.decision,
      reasonCode: input.reasonCode,
      finalDigest: input.finalDigest ?? null,
      createdAt: input.createdAt ?? Date.now(),
    };
    this.db.prepare(`
      INSERT INTO brain_outcomes (
        id, brain_id, user_id, session_id, source, kind,
        proposal_digest, context_digest, decision, reason_code,
        final_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.brainId, row.userId, row.sessionId, row.source, row.kind,
      row.proposalDigest, row.contextDigest, row.decision, row.reasonCode,
      row.finalDigest, row.createdAt,
    );
    return row;
  }

  /** Recent privacy-safe decisions for deduplication and diagnostics. */
  getRecentBrainOutcomes(userId: string, sinceMs = 0, limit = 100): BrainOutcomeRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM brain_outcomes
      WHERE user_id = ? AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(userId, sinceMs, Math.max(1, Math.min(1_000, Math.floor(limit)))) as Record<string, unknown>[];
    return rows.map(row => ({
      id: String(row.id),
      brainId: String(row.brain_id),
      userId: String(row.user_id),
      sessionId: row.session_id == null ? null : String(row.session_id),
      source: String(row.source),
      kind: row.kind as BrainOutcomeKind,
      proposalDigest: String(row.proposal_digest),
      contextDigest: String(row.context_digest),
      decision: row.decision as BrainOutcomeDecision,
      reasonCode: String(row.reason_code),
      finalDigest: row.final_digest == null ? null : String(row.final_digest),
      createdAt: Number(row.created_at),
    }));
  }

  // ============ Session Operations ============

  createSession(id: string, metadata?: Record<string, unknown>): SessionRow {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        id, metadata, input_tokens, output_tokens, created_at, updated_at,
        archived_at, archive_reason, transcript_deleted_at
      )
      VALUES (?, ?, 0, 0, ?, ?, NULL, NULL, NULL)
    `);
    stmt.run(id, metadata ? JSON.stringify(metadata) : null, now, now);
    return {
      id,
      metadata: metadata || null,
      inputTokens: 0,
      outputTokens: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      archiveReason: null,
      transcriptDeletedAt: null,
    };
  }

  /** Return durable session metadata, including archived/forgotten tombstones. */
  getSession(id: string): SessionRow | null {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToSession(row) : null;
  }

  /** Return a resumable session only. */
  getActiveSession(id: string): SessionRow | null {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions
      WHERE id = ? AND archived_at IS NULL AND transcript_deleted_at IS NULL
    `);
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToSession(row) : null;
  }

  /**
   * Close a session while preserving its full transcript and any summary.
   * Repeated calls are idempotent and produce a single archive audit event.
   */
  archiveSession(id: string, reason: string = 'new_conversation', actor: string = 'system'): boolean {
    const archive = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT id, metadata, archived_at, transcript_deleted_at,
          (SELECT COUNT(*) FROM session_messages WHERE session_id = sessions.id) AS message_count
        FROM sessions
        WHERE id = ?
      `).get(id) as Record<string, unknown> | undefined;
      if (!row || row.archived_at != null || row.transcript_deleted_at != null) return false;

      const now = Date.now();
      const result = this.db.prepare(`
        UPDATE sessions
        SET archived_at = ?, archive_reason = ?
        WHERE id = ? AND archived_at IS NULL AND transcript_deleted_at IS NULL
      `).run(now, reason, id);
      if (result.changes === 0) return false;

      this.insertSessionLifecycleEvent({
        sessionId: id,
        userId: this.sessionUserIdFromMetadata(row.metadata),
        action: 'archived',
        reason,
        actor,
        messageCount: Number(row.message_count ?? 0),
        createdAt: now,
      });
      return true;
    });
    return archive();
  }

  /** Archive old empty top-level sessions without deleting metadata or history. */
  archiveStaleEmptySessions(maxAgeMs: number, now: number = Date.now()): number {
    const cutoff = now - Math.max(0, maxAgeMs);
    const rows = this.db.prepare(`
      SELECT id
      FROM sessions
      WHERE archived_at IS NULL AND transcript_deleted_at IS NULL
        AND updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM session_messages WHERE session_id = sessions.id)
        AND NOT EXISTS (SELECT 1 FROM session_message_archive WHERE session_id = sessions.id)
        AND COALESCE(json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.isSubAgent'), 0) != 1
        AND COALESCE(json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.source'), '') != 'scheduler'
    `).all(cutoff) as Array<{ id: string }>;
    let archived = 0;
    for (const row of rows) {
      if (this.archiveSession(row.id, 'stale_empty_session', 'gardener')) archived++;
    }
    return archived;
  }

  /** Archive every active session for one durable channel identity. */
  archiveActiveSessionsByUserId(
    userId: string,
    reason: string = 'new_conversation',
    actor: string = 'system',
    channelId?: string,
  ): number {
    const rows = this.db.prepare(`
      SELECT id, metadata
      FROM sessions
      WHERE archived_at IS NULL
        AND transcript_deleted_at IS NULL
    `).all() as Array<{ id: string; metadata: string | null }>;
    let archived = 0;
    for (const row of rows) {
      let metadata: Record<string, unknown>;
      try {
        const parsed = row.metadata ? JSON.parse(row.metadata) as unknown : null;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        metadata = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (metadata.userId !== userId) continue;
      if (channelId && typeof metadata.channelId === 'string' && metadata.channelId !== channelId) continue;
      // A user's primary conversation and its worker sessions deliberately
      // share identity metadata. /new must not interrupt an in-flight worker.
      if (metadata.isSubAgent === true || metadata.source === 'scheduler') continue;
      if (this.archiveSession(row.id, reason, actor)) archived++;
    }
    return archived;
  }

  /**
   * Destructively forget a transcript while retaining a non-resumable session
   * tombstone, its summary, and an append-only audit event. User-facing callers
   * must put confirmation in front of this low-level operation.
   */
  deleteSession(id: string, reason: string = 'explicit_forget', actor: string = 'system'): boolean {
    const forget = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT id, metadata, archived_at, transcript_deleted_at,
          (
            SELECT COUNT(*) FROM (
              SELECT id AS message_id FROM session_messages WHERE session_id = sessions.id
              UNION
              SELECT original_message_id AS message_id
              FROM session_message_archive WHERE session_id = sessions.id
            )
          ) AS message_count,
          EXISTS (
            SELECT 1 FROM session_lifecycle_events
            WHERE session_id = sessions.id AND action = 'forgotten'
          ) AS already_forgotten
        FROM sessions
        WHERE id = ?
      `).get(id) as Record<string, unknown> | undefined;
      if (!row) return false;

      const now = Date.now();
      const messageCount = Number(row.message_count ?? 0);
      this.db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM session_message_archive WHERE session_id = ?').run(id);
      this.db.prepare(`
        UPDATE sessions
        SET archived_at = COALESCE(archived_at, ?),
            archive_reason = ?,
            transcript_deleted_at = ?
        WHERE id = ?
      `).run(now, reason, now, id);
      if (Number(row.already_forgotten ?? 0) === 0) {
        this.insertSessionLifecycleEvent({
          sessionId: id,
          userId: this.sessionUserIdFromMetadata(row.metadata),
          action: 'forgotten',
          reason,
          actor,
          messageCount,
          createdAt: now,
        });
      }
      return true;
    });
    return forget();
  }

  listSessions(limit?: number, offset?: number, includeArchived: boolean = false): SessionRow[] {
    let query = 'SELECT * FROM sessions';
    const params: unknown[] = [];
    if (!includeArchived) {
      query += ' WHERE archived_at IS NULL AND transcript_deleted_at IS NULL';
    }
    query += ' ORDER BY updated_at DESC';
    if (limit) {
      query += ' LIMIT ?';
      params.push(limit);
    }
    if (offset) {
      query += ' OFFSET ?';
      params.push(offset);
    }
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map(row => this.rowToSession(row));
  }

  updateSessionMetadata(id: string, metadata: Record<string, unknown>): void {
    const now = Date.now();
    // Merge with existing metadata
    const existing = this.getActiveSession(id);
    const merged = { ...(existing?.metadata || {}), ...metadata };
    this.db.prepare('UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(merged), now, id);
  }

  updateSessionTokenUsage(id: string, inputTokens: number, outputTokens: number): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE sessions SET
        input_tokens = input_tokens + ?,
        output_tokens = output_tokens + ?,
        updated_at = ?
      WHERE id = ?
    `).run(inputTokens, outputTokens, now, id);
  }

  addSessionMessage(
    sessionId: string,
    role: string,
    content: string,
    messageKind?: PersistedSessionMessageKind,
  ): SessionMessageRow {
    const now = Date.now();
    const metadata = this.getSession(sessionId)?.metadata;
    const resolvedKind = messageKind ?? inferSessionMessageKind(role, content, metadata);
    const stmt = this.db.prepare(`
      INSERT INTO session_messages (session_id, role, content, message_kind, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(sessionId, role, content, resolvedKind, now);
    // Update session updated_at
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
    return {
      id: Number(result.lastInsertRowid), sessionId, role, content,
      messageKind: resolvedKind, createdAt: now,
    };
  }

  getSessionMessages(sessionId: string): SessionMessageRow[] {
    const stmt = this.db.prepare(`
      SELECT sm.*, s.metadata AS session_metadata
      FROM session_messages sm
      LEFT JOIN sessions s ON s.id = sm.session_id
      WHERE sm.session_id = ? ORDER BY sm.id
    `);
    const rows = stmt.all(sessionId) as Record<string, unknown>[];
    return rows.map(row => this.rowToSessionMessage(row));
  }

  getSessionMessagesPaginated(sessionId: string, limit: number, before?: number): { messages: SessionMessageRow[]; hasMore: boolean } {
    let rows: Record<string, unknown>[];
    if (before) {
      const stmt = this.db.prepare(
        `SELECT sm.*, s.metadata AS session_metadata
         FROM session_messages sm LEFT JOIN sessions s ON s.id = sm.session_id
         WHERE sm.session_id = ? AND sm.id < ? ORDER BY sm.id DESC LIMIT ?`
      );
      rows = stmt.all(sessionId, before, limit + 1) as Record<string, unknown>[];
    } else {
      const stmt = this.db.prepare(
        `SELECT sm.*, s.metadata AS session_metadata
         FROM session_messages sm LEFT JOIN sessions s ON s.id = sm.session_id
         WHERE sm.session_id = ? ORDER BY sm.id DESC LIMIT ?`
      );
      rows = stmt.all(sessionId, limit + 1) as Record<string, unknown>[];
    }
    const hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
    rows.reverse();
    return { messages: rows.map(row => this.rowToSessionMessage(row)), hasMore };
  }

  /** Get paginated messages across ALL sessions (cross-channel unified history) */
  getAllMessagesPaginated(limit: number, before?: number): { messages: SessionMessageRow[]; hasMore: boolean } {
    let rows: Record<string, unknown>[];
    if (before) {
      const stmt = this.db.prepare(
        `SELECT sm.*, s.metadata AS session_metadata
         FROM session_messages sm LEFT JOIN sessions s ON s.id = sm.session_id
         WHERE sm.id < ? ORDER BY sm.id DESC LIMIT ?`
      );
      rows = stmt.all(before, limit + 1) as Record<string, unknown>[];
    } else {
      const stmt = this.db.prepare(
        `SELECT sm.*, s.metadata AS session_metadata
         FROM session_messages sm LEFT JOIN sessions s ON s.id = sm.session_id
         ORDER BY sm.id DESC LIMIT ?`
      );
      rows = stmt.all(limit + 1) as Record<string, unknown>[];
    }
    const hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
    rows.reverse();
    return { messages: rows.map(row => this.rowToSessionMessage(row)), hasMore };
  }

  /**
   * Get recent messages belonging to one user across their sessions.
   *
   * Session messages do not carry a user_id themselves; the owning session
   * does. Callers may supply an explicit set of channel aliases belonging to
   * the same durable state owner. `default` is never a wildcard.
   */
  getRecentMessagesByUserId(
    userId: string,
    limit: number,
    identityCandidates?: readonly string[],
  ): SessionMessageRow[] {
    const candidates = [...new Set(
      (identityCandidates?.length ? identityCandidates : [userId])
        .map(candidate => candidate.trim())
        .filter(Boolean),
    )];
    if (candidates.length === 0) return [];
    const placeholders = candidates.map(() => '?').join(', ');
    const stmt = this.db.prepare(`
      SELECT sm.*, s.metadata AS session_metadata
      FROM session_messages sm
      INNER JOIN sessions s ON s.id = sm.session_id
      WHERE json_extract(s.metadata, '$.userId') IN (${placeholders})
      ORDER BY sm.id DESC
      LIMIT ?
    `);
    const rows = stmt.all(...candidates, limit) as Record<string, unknown>[];
    rows.reverse();
    return rows.map(row => this.rowToSessionMessage(row));
  }

  findSessionByUserId(userId: string, channelId?: string): SessionRow | null {
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE archived_at IS NULL AND transcript_deleted_at IS NULL
      ORDER BY updated_at DESC
    `).all() as Record<string, unknown>[];
    for (const row of rows) {
      const session = this.rowToSession(row);
      if (session.metadata?.userId !== userId) continue;
      if (channelId
        && typeof session.metadata?.channelId === 'string'
        && session.metadata.channelId !== channelId) continue;
      if (session.metadata?.isSubAgent === true || session.metadata?.source === 'scheduler') continue;
      return session;
    }
    return null;
  }

  getSessionLifecycleEvents(sessionId: string): SessionLifecycleEventRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM session_lifecycle_events
      WHERE session_id = ?
      ORDER BY id
    `).all(sessionId) as Record<string, unknown>[];
    return rows.map(row => ({
      id: row.id as number,
      sessionId: row.session_id as string,
      userId: row.user_id as string | null,
      action: row.action as SessionLifecycleEventRow['action'],
      reason: row.reason as string,
      actor: row.actor as string,
      messageCount: row.message_count as number,
      createdAt: row.created_at as number,
    }));
  }

  /** Read the cold, lossless copy of a transcript after hot-row pruning. */
  getArchivedSessionMessages(sessionId: string): SessionMessageRow[] {
    const rows = this.db.prepare(`
      SELECT archive.original_message_id AS id, archive.session_id,
        archive.role, archive.content, archive.message_kind, archive.created_at,
        s.metadata AS session_metadata
      FROM session_message_archive archive
      LEFT JOIN sessions s ON s.id = archive.session_id
      WHERE archive.session_id = ?
      ORDER BY archive.original_message_id
    `).all(sessionId) as Record<string, unknown>[];
    return rows.map(row => this.rowToSessionMessage(row));
  }

  private sessionUserIdFromMetadata(rawMetadata: unknown): string | null {
    if (typeof rawMetadata !== 'string') return null;
    try {
      const parsed = JSON.parse(rawMetadata) as Record<string, unknown>;
      return typeof parsed.userId === 'string' ? parsed.userId : null;
    } catch {
      return null;
    }
  }

  private insertSessionLifecycleEvent(event: Omit<SessionLifecycleEventRow, 'id'>): void {
    this.db.prepare(`
      INSERT INTO session_lifecycle_events
        (session_id, user_id, action, reason, actor, message_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.sessionId,
      event.userId,
      event.action,
      event.reason,
      event.actor,
      event.messageCount,
      event.createdAt,
    );
  }

  // ============ Session Summary Operations ============

  addSessionSummary(
    summary: SessionSummaryInput,
    verification?: SessionSummaryVerificationRequest,
  ): SessionSummaryRow {
    const store = this.db.transaction(() => {
      const id = nanoid();
      const now = Date.now();
      const requestValid = !!verification
        && verification.verifier.trim().length > 0
        && Number.isInteger(verification.verificationVersion)
        && verification.verificationVersion > 0;
      const evaluation = verification && requestValid
        ? this.evaluateSessionSummaryVerification(summary, false)
        : {
            valid: false,
            reason: verification ? 'invalid_verification_request' : 'verification_not_requested',
          };
      const schemaValid = requestValid && evaluation.valid;
      const verifiedAt = schemaValid
        ? (Number.isFinite(verification?.verifiedAt) ? verification!.verifiedAt! : now)
        : null;
      const verifier = verification?.verifier.trim() || null;
      const verificationVersion = verification?.verificationVersion ?? null;

      this.db.prepare(`
        INSERT INTO session_summaries (
          id, session_id, user_id, summary, topics, message_count, duration_ms,
          embedding, created_at, verified_at, verifier, verification_version, schema_valid
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        summary.sessionId,
        summary.userId,
        summary.summary,
        JSON.stringify(summary.topics),
        summary.messageCount,
        summary.durationMs,
        summary.embedding ? JSON.stringify(summary.embedding) : null,
        now,
        verifiedAt,
        verifier,
        verificationVersion,
        schemaValid ? 1 : 0,
      );

      this.insertSessionSummaryVerificationEvent({
        summaryId: id,
        sessionId: summary.sessionId,
        outcome: schemaValid ? 'verified' : 'rejected',
        verifier: verifier ?? 'unverified_writer',
        verificationVersion: verificationVersion ?? 0,
        reason: evaluation.reason,
        checkedAt: now,
      });

      return {
        ...summary,
        id,
        createdAt: now,
        verifiedAt,
        verifier,
        verificationVersion,
        schemaValid,
      };
    });
    return store();
  }

  /**
   * Regenerate a rejected summary without deleting it. A valid replacement
   * snapshots the current row before updating its stable ID; an invalid
   * candidate is also retained in revision history for diagnosis.
   */
  upsertVerifiedSessionSummary(
    summary: SessionSummaryInput,
    verification: SessionSummaryVerificationRequest,
  ): SessionSummaryRow {
    const existing = this.getSessionSummary(summary.sessionId);
    if (!existing) return this.addSessionSummary(summary, verification);
    if (this.hasVerifiedSessionSummary(summary.sessionId)) return existing;

    const replace = this.db.transaction(() => {
      const now = Date.now();
      const requestValid = verification.verifier.trim().length > 0
        && Number.isInteger(verification.verificationVersion)
        && verification.verificationVersion > 0;
      const evaluation = requestValid
        ? this.evaluateSessionSummaryVerification(summary, false)
        : { valid: false, reason: 'invalid_verification_request' };

      if (!evaluation.valid) {
        const candidateRevisionId = this.insertSessionSummaryRevision({
          summaryId: existing.id,
          summary,
          createdAt: now,
          verifiedAt: null,
          verifier: verification.verifier.trim() || null,
          verificationVersion: verification.verificationVersion,
          schemaValid: false,
          reason: `rejected_regeneration_candidate:${evaluation.reason}`,
          archivedAt: now,
        });
        this.insertSessionSummaryVerificationEvent({
          summaryId: candidateRevisionId,
          sessionId: summary.sessionId,
          outcome: 'rejected',
          verifier: verification.verifier.trim() || 'unknown_verifier',
          verificationVersion: verification.verificationVersion,
          reason: evaluation.reason,
          checkedAt: now,
        });
        return existing;
      }

      this.insertSessionSummaryRevision({
        summaryId: existing.id,
        summary: existing,
        createdAt: existing.createdAt,
        verifiedAt: existing.verifiedAt ?? null,
        verifier: existing.verifier ?? null,
        verificationVersion: existing.verificationVersion ?? null,
        schemaValid: existing.schemaValid === true,
        reason: 'superseded_by_verified_regeneration',
        archivedAt: now,
      });
      const verifiedAt = Number.isFinite(verification.verifiedAt)
        ? verification.verifiedAt!
        : now;
      this.db.prepare(`
        UPDATE session_summaries
        SET user_id = ?, summary = ?, topics = ?, message_count = ?,
            duration_ms = ?, embedding = ?, created_at = ?, verified_at = ?,
            verifier = ?, verification_version = ?, schema_valid = 1
        WHERE id = ?
      `).run(
        summary.userId,
        summary.summary,
        JSON.stringify(summary.topics),
        summary.messageCount,
        summary.durationMs,
        summary.embedding ? JSON.stringify(summary.embedding) : null,
        now,
        verifiedAt,
        verification.verifier.trim(),
        verification.verificationVersion,
        existing.id,
      );
      this.insertSessionSummaryVerificationEvent({
        summaryId: existing.id,
        sessionId: summary.sessionId,
        outcome: 'verified',
        verifier: verification.verifier.trim(),
        verificationVersion: verification.verificationVersion,
        reason: evaluation.reason,
        checkedAt: now,
      });
      return this.getSessionSummary(summary.sessionId)!;
    });
    return replace();
  }

  hasVerifiedSessionSummary(sessionId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1
      FROM session_summaries summary
      WHERE summary.session_id = ?
        AND summary.schema_valid = 1
        AND summary.verified_at IS NOT NULL
        AND summary.verifier IS NOT NULL
        AND summary.verification_version >= 1
        AND EXISTS (
          SELECT 1 FROM session_summary_verification_events receipt
          WHERE receipt.summary_id = summary.id
            AND receipt.outcome = 'verified'
            AND receipt.verifier = summary.verifier
            AND receipt.verification_version = summary.verification_version
        )
      LIMIT 1
    `).get(sessionId);
    return !!row;
  }

  /** Re-evaluate a preserved interim summary against its durable transcript. */
  verifySessionSummary(
    sessionId: string,
    verification: SessionSummaryVerificationRequest,
  ): SessionSummaryRow | null {
    const verify = this.db.transaction(() => {
      const existing = this.getSessionSummary(sessionId);
      if (!existing) return null;
      const requestValid = verification.verifier.trim().length > 0
        && Number.isInteger(verification.verificationVersion)
        && verification.verificationVersion > 0;
      const evaluation = requestValid
        ? this.evaluateSessionSummaryVerification(existing, false)
        : { valid: false, reason: 'invalid_verification_request' };
      const checkedAt = Date.now();
      const verifiedAt = evaluation.valid
        ? (Number.isFinite(verification.verifiedAt) ? verification.verifiedAt! : checkedAt)
        : null;
      this.db.prepare(`
        UPDATE session_summaries
        SET verified_at = ?, verifier = ?, verification_version = ?, schema_valid = ?
        WHERE id = ?
      `).run(
        verifiedAt,
        verification.verifier.trim(),
        verification.verificationVersion,
        evaluation.valid ? 1 : 0,
        existing.id,
      );
      this.insertSessionSummaryVerificationEvent({
        summaryId: existing.id,
        sessionId,
        outcome: evaluation.valid ? 'verified' : 'rejected',
        verifier: verification.verifier.trim() || 'unknown_verifier',
        verificationVersion: verification.verificationVersion,
        reason: evaluation.reason,
        checkedAt,
      });
      return this.getSessionSummary(sessionId);
    });
    return verify();
  }

  getSessionSummaryVerificationEvents(summaryId: string): SessionSummaryVerificationEventRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM session_summary_verification_events
      WHERE summary_id = ? ORDER BY id
    `).all(summaryId) as Record<string, unknown>[];
    return rows.map(row => ({
      id: Number(row.id),
      summaryId: String(row.summary_id),
      sessionId: String(row.session_id),
      outcome: row.outcome as SessionSummaryVerificationEventRow['outcome'],
      verifier: String(row.verifier),
      verificationVersion: Number(row.verification_version),
      reason: String(row.reason),
      checkedAt: Number(row.checked_at),
    }));
  }

  getSessionSummaryRevisions(sessionId: string): SessionSummaryRevisionRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM session_summary_revisions
      WHERE session_id = ? ORDER BY revision_number
    `).all(sessionId) as Record<string, unknown>[];
    return rows.map(row => ({
      id: String(row.summary_id),
      revisionId: String(row.id),
      summaryId: String(row.summary_id),
      sessionId: String(row.session_id),
      revisionNumber: Number(row.revision_number),
      userId: String(row.user_id ?? 'default'),
      summary: String(row.summary),
      topics: this.parseSummaryTopics(row.topics) ?? [],
      messageCount: Number(row.message_count),
      durationMs: Number(row.duration_ms),
      embedding: row.embedding ? JSON.parse(String(row.embedding)) as number[] : null,
      createdAt: Number(row.original_created_at),
      verifiedAt: row.verified_at == null ? null : Number(row.verified_at),
      verifier: row.verifier == null ? null : String(row.verifier),
      verificationVersion: row.verification_version == null
        ? null
        : Number(row.verification_version),
      schemaValid: Number(row.schema_valid) === 1,
      revisionReason: String(row.revision_reason),
      archivedAt: Number(row.archived_at),
    }));
  }

  getSessionSummary(sessionId: string): SessionSummaryRow | null {
    const row = this.db.prepare(
      `SELECT * FROM session_summaries
       WHERE session_id = ?
       ORDER BY schema_valid DESC, verified_at DESC, created_at DESC
       LIMIT 1`
    ).get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.rowToSessionSummary(row) : null;
  }

  getSessionSummariesByUser(userId: string, limit: number = 20): SessionSummaryRow[] {
    const rows = this.db.prepare(
      'SELECT * FROM session_summaries WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(userId, limit) as Record<string, unknown>[];
    return rows.map(row => this.rowToSessionSummary(row));
  }

  getAllSessionSummaries(limit: number = 50): SessionSummaryRow[] {
    const rows = this.db.prepare(
      'SELECT * FROM session_summaries ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as Record<string, unknown>[];
    return rows.map(row => this.rowToSessionSummary(row));
  }

  getSessionSummaryCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number };
    return row.count;
  }

  getSessionSummaryFailure(sessionId: string): SessionSummaryFailureState | null {
    const row = this.db.prepare(`
      SELECT session_id AS key, failure_count, last_failure_at, next_retry_at, last_error_code
      FROM session_summary_failures WHERE session_id = ?
    `).get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.rowToSessionSummaryFailureState(row) : null;
  }

  recordSessionSummaryFailure(
    sessionId: string,
    errorCode: string,
    now: number = Date.now(),
  ): SessionSummaryFailureState {
    const record = this.db.transaction(() => {
      const prior = this.getSessionSummaryFailure(sessionId);
      const failureCount = (prior?.failureCount ?? 0) + 1;
      const nextRetryAt = now + summaryFailureBackoffMs(failureCount);
      this.db.prepare(`
        INSERT INTO session_summary_failures
          (session_id, failure_count, last_failure_at, next_retry_at, last_error_code)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          failure_count = excluded.failure_count,
          last_failure_at = excluded.last_failure_at,
          next_retry_at = excluded.next_retry_at,
          last_error_code = excluded.last_error_code
      `).run(sessionId, failureCount, now, nextRetryAt, errorCode);
      return { key: sessionId, failureCount, lastFailureAt: now, nextRetryAt, lastErrorCode: errorCode };
    });
    return record.immediate();
  }

  clearSessionSummaryFailure(sessionId: string): void {
    this.db.prepare('DELETE FROM session_summary_failures WHERE session_id = ?').run(sessionId);
  }

  getStructuredRouteCircuit(route: string): SessionSummaryFailureState | null {
    const row = this.db.prepare(`
      SELECT route AS key, failure_count, last_failure_at, next_retry_at, last_error_code
      FROM structured_route_circuits WHERE route = ?
    `).get(route) as Record<string, unknown> | undefined;
    return row ? this.rowToSessionSummaryFailureState(row) : null;
  }

  recordStructuredRouteFailure(
    route: string,
    errorCode: string,
    now: number = Date.now(),
  ): SessionSummaryFailureState {
    const record = this.db.transaction(() => {
      const prior = this.getStructuredRouteCircuit(route);
      const failureCount = (prior?.failureCount ?? 0) + 1;
      const nextRetryAt = now + summaryFailureBackoffMs(failureCount);
      this.db.prepare(`
        INSERT INTO structured_route_circuits
          (route, failure_count, last_failure_at, next_retry_at, last_error_code)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(route) DO UPDATE SET
          failure_count = excluded.failure_count,
          last_failure_at = excluded.last_failure_at,
          next_retry_at = excluded.next_retry_at,
          last_error_code = excluded.last_error_code
      `).run(route, failureCount, now, nextRetryAt, errorCode);
      return { key: route, failureCount, lastFailureAt: now, nextRetryAt, lastErrorCode: errorCode };
    });
    return record.immediate();
  }

  clearStructuredRouteCircuit(route: string): void {
    this.db.prepare('DELETE FROM structured_route_circuits WHERE route = ?').run(route);
  }

  private parseSummaryTopics(raw: unknown): string[] | null {
    let parsed = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    }
    if (!Array.isArray(parsed) || !parsed.every(topic => typeof topic === 'string')) return null;
    return parsed.map(topic => topic.trim());
  }

  /** Structural + transcript-bound verification used by retention receipts. */
  private evaluateSessionSummaryVerification(
    summary: {
      sessionId: string;
      summary: string;
      topics: unknown;
      messageCount: number;
      durationMs: number;
    },
    legacyAudit: boolean,
  ): { valid: boolean; reason: string } {
    const text = typeof summary.summary === 'string' ? summary.summary.trim() : '';
    const minimumLength = legacyAudit ? 20 : 10;
    if (text.length < minimumLength || text.length > 12_000) {
      return { valid: false, reason: 'summary_text_out_of_bounds' };
    }
    const topics = this.parseSummaryTopics(summary.topics);
    if (!topics || topics.length < 1 || topics.length > 20
      || topics.some(topic => topic.length < 1 || topic.length > 100)) {
      return { valid: false, reason: 'topics_schema_invalid' };
    }
    if (!Number.isInteger(summary.messageCount) || summary.messageCount < 2) {
      return { valid: false, reason: 'message_count_invalid' };
    }
    if (!Number.isFinite(summary.durationMs) || summary.durationMs < 0) {
      return { valid: false, reason: 'duration_invalid' };
    }

    const session = this.getSession(summary.sessionId);
    if (!session) return { valid: false, reason: 'source_session_missing' };
    const rows = this.db.prepare(`
      SELECT id AS message_id, role, content, message_kind
      FROM session_messages WHERE session_id = ?
      UNION ALL
      SELECT original_message_id AS message_id, role, content, message_kind
      FROM session_message_archive WHERE session_id = ?
    `).all(summary.sessionId, summary.sessionId) as Array<{
      message_id: number;
      role: string;
      content: string;
      message_kind: unknown;
    }>;
    const messages = new Map<number, typeof rows[number]>();
    // Hot rows are selected first and remain authoritative during a partially
    // completed archive transaction; cold duplicates are ignored by ID.
    for (const row of rows) {
      if (!messages.has(row.message_id)) messages.set(row.message_id, row);
    }

    let humanTurns = 0;
    let assistantFinals = 0;
    for (const row of messages.values()) {
      const inferred = inferSessionMessageKind(row.role, row.content, session.metadata);
      const kind = isPersistedSessionMessageKind(row.message_kind) ? row.message_kind : inferred;
      if ((kind === 'human_user' || kind === 'assistant_final') && kind !== inferred) {
        return { valid: false, reason: 'visible_message_kind_mismatch' };
      }
      if (kind === 'human_user') humanTurns++;
      if (kind === 'assistant_final') assistantFinals++;
    }
    const visibleCount = humanTurns + assistantFinals;
    if (humanTurns < 1 || assistantFinals < 1) {
      return { valid: false, reason: 'conversation_pair_missing' };
    }
    if (visibleCount !== summary.messageCount) {
      return { valid: false, reason: 'message_count_mismatch' };
    }
    return {
      valid: true,
      reason: legacyAudit ? 'legacy_structure_and_transcript_match' : 'schema_and_transcript_match',
    };
  }

  private insertSessionSummaryRevision(input: {
    summaryId: string;
    summary: SessionSummaryInput | SessionSummaryRow;
    createdAt: number;
    verifiedAt: number | null;
    verifier: string | null;
    verificationVersion: number | null;
    schemaValid: boolean;
    reason: string;
    archivedAt: number;
  }): string {
    const prior = this.db.prepare(`
      SELECT MAX(revision_number) AS revision_number
      FROM session_summary_revisions WHERE summary_id = ?
    `).get(input.summaryId) as { revision_number: number | null };
    const revisionNumber = (prior.revision_number ?? 0) + 1;
    const revisionId = nanoid();
    this.db.prepare(`
      INSERT INTO session_summary_revisions (
        id, summary_id, session_id, user_id, revision_number, summary, topics,
        message_count, duration_ms, embedding, original_created_at,
        verified_at, verifier, verification_version, schema_valid,
        revision_reason, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      revisionId,
      input.summaryId,
      input.summary.sessionId,
      input.summary.userId,
      revisionNumber,
      input.summary.summary,
      JSON.stringify(input.summary.topics),
      input.summary.messageCount,
      input.summary.durationMs,
      input.summary.embedding ? JSON.stringify(input.summary.embedding) : null,
      input.createdAt,
      input.verifiedAt,
      input.verifier,
      input.verificationVersion,
      input.schemaValid ? 1 : 0,
      input.reason,
      input.archivedAt,
    );
    return revisionId;
  }

  private insertSessionSummaryVerificationEvent(
    event: Omit<SessionSummaryVerificationEventRow, 'id'>,
  ): void {
    this.db.prepare(`
      INSERT INTO session_summary_verification_events (
        summary_id, session_id, outcome, verifier,
        verification_version, reason, checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.summaryId,
      event.sessionId,
      event.outcome,
      event.verifier,
      event.verificationVersion,
      event.reason,
      event.checkedAt,
    );
  }

  private rowToSessionSummaryFailureState(row: Record<string, unknown>): SessionSummaryFailureState {
    return {
      key: row.key as string,
      failureCount: Number(row.failure_count),
      lastFailureAt: Number(row.last_failure_at),
      nextRetryAt: Number(row.next_retry_at),
      lastErrorCode: row.last_error_code as string,
    };
  }

  private rowToSessionSummary(row: Record<string, unknown>): SessionSummaryRow {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      userId: row.user_id as string,
      summary: row.summary as string,
      topics: this.parseSummaryTopics(row.topics) ?? [],
      messageCount: row.message_count as number,
      durationMs: row.duration_ms as number,
      embedding: row.embedding ? JSON.parse(row.embedding as string) : null,
      createdAt: row.created_at as number,
      verifiedAt: row.verified_at == null ? null : Number(row.verified_at),
      verifier: row.verifier == null ? null : String(row.verifier),
      verificationVersion: row.verification_version == null ? null : Number(row.verification_version),
      schemaValid: Number(row.schema_valid ?? 0) === 1,
    };
  }

  /**
   * Prune raw transcripts only after a session has been explicitly archived
   * and has a verified durable summary. The session tombstone and summary are
   * retained, and unsummarized sessions are never touched.
   *
   * The historical method name is kept for API compatibility.
   */
  pruneOldSessions(maxAgeDays: number = 30): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const prune = this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT s.id, s.metadata,
          (SELECT COUNT(*) FROM session_messages WHERE session_id = s.id) AS message_count
        FROM sessions s
        WHERE s.updated_at < ?
          AND s.archived_at IS NOT NULL
          AND s.transcript_deleted_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM session_summaries summary
            WHERE summary.session_id = s.id
              AND summary.schema_valid = 1
              AND summary.verified_at IS NOT NULL
              AND summary.verifier IS NOT NULL
              AND summary.verification_version >= 1
              AND EXISTS (
                SELECT 1 FROM session_summary_verification_events receipt
                WHERE receipt.summary_id = summary.id
                  AND receipt.outcome = 'verified'
                  AND receipt.verifier = summary.verifier
                  AND receipt.verification_version = summary.verification_version
              )
          )
      `).all(cutoff) as Record<string, unknown>[];

      const now = Date.now();
      let pruned = 0;
      for (const row of rows) {
        const sessionId = row.id as string;
        const summaryRow = this.db.prepare(`
          SELECT * FROM session_summaries
          WHERE session_id = ? AND schema_valid = 1 AND verified_at IS NOT NULL
          ORDER BY verified_at DESC LIMIT 1
        `).get(sessionId) as Record<string, unknown> | undefined;
        if (!summaryRow) continue;
        const summary = this.rowToSessionSummary(summaryRow);
        const revalidation = this.evaluateSessionSummaryVerification(summary, false);
        if (!revalidation.valid) {
          this.db.prepare(`
            UPDATE session_summaries
            SET schema_valid = 0, verified_at = NULL
            WHERE id = ?
          `).run(summary.id);
          this.insertSessionSummaryVerificationEvent({
            summaryId: summary.id,
            sessionId,
            outcome: 'rejected',
            verifier: 'retention_revalidation',
            verificationVersion: 1,
            reason: revalidation.reason,
            checkedAt: now,
          });
          continue;
        }
        this.db.prepare(`
          INSERT OR IGNORE INTO session_message_archive (
            original_message_id, session_id, role, content, message_kind, created_at,
            archived_at, archive_reason
          )
          SELECT id, session_id, role, content, message_kind, created_at, ?,
            'retention_after_verified_summary'
          FROM session_messages
          WHERE session_id = ?
        `).run(now, sessionId);

        const missing = this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM session_messages live
          LEFT JOIN session_message_archive cold
            ON cold.original_message_id = live.id
          WHERE live.session_id = ?
            AND (
              cold.original_message_id IS NULL
              OR cold.message_kind IS NULL
              OR cold.message_kind != live.message_kind
            )
        `).get(sessionId) as { count: number };
        if (missing.count > 0) {
          throw new Error(`Refusing to prune ${sessionId}: ${missing.count} message(s) were not archived`);
        }
        this.db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(sessionId);
        this.db.prepare(`
          UPDATE sessions
          SET transcript_deleted_at = ?
          WHERE id = ? AND transcript_deleted_at IS NULL
        `).run(now, sessionId);
        this.insertSessionLifecycleEvent({
          sessionId,
          userId: this.sessionUserIdFromMetadata(row.metadata),
          action: 'transcript_pruned',
          reason: 'retention_after_verified_summary_and_raw_archive',
          actor: 'gardener',
          messageCount: Number(row.message_count ?? 0),
          createdAt: now,
        });
        pruned++;
      }
      return pruned;
    });
    return prune();
  }

  /**
   * Delete archived/dormant memories with prominence below threshold.
   * Returns the number of memories deleted.
   */
  pruneArchivedMemories(maxProminence: number = 0.01): number {
    // Also clean up relations pointing to deleted memories
    const ids = this.db.prepare(
      'SELECT id FROM memories WHERE prominence < ? AND is_latest = 0'
    ).all(maxProminence) as Array<{ id: string }>;
    if (ids.length === 0) return 0;

    const idList = ids.map(r => r.id);
    for (const id of idList) {
      this.db.prepare('DELETE FROM memory_relations WHERE source_id = ? OR target_id = ?').run(id, id);
    }
    const result = this.db.prepare(
      `DELETE FROM memories WHERE prominence < ? AND is_latest = 0`
    ).run(maxProminence);
    return result.changes;
  }

  // ============ Bot Config Operations ============

  getBotConfig(userId: string): BotConfigRow | null {
    const stmt = this.db.prepare('SELECT * FROM bot_config WHERE user_id = ?');
    const row = stmt.get(userId) as Record<string, unknown> | undefined;
    return row ? this.rowToBotConfig(row) : null;
  }

  upsertBotConfig(userId: string, config: Partial<Omit<BotConfigRow, 'userId'>>): BotConfigRow {
    const now = new Date().toISOString();
    const existing = this.getBotConfig(userId);

    if (existing) {
      this.db.prepare(`
        UPDATE bot_config SET
          bot_name = COALESCE(?, bot_name),
          personality_id = COALESCE(?, personality_id),
          custom_personality = ?,
          model_id = COALESCE(?, model_id),
          timezone = COALESCE(?, timezone),
          onboarding_complete = COALESCE(?, onboarding_complete),
          onboarding_step = COALESCE(?, onboarding_step),
          updated_at = ?
        WHERE user_id = ?
      `).run(
        config.botName ?? null,
        config.personalityId ?? null,
        config.customPersonality !== undefined ? config.customPersonality : existing.customPersonality,
        config.modelId ?? null,
        config.timezone ?? null,
        config.onboardingComplete !== undefined ? (config.onboardingComplete ? 1 : 0) : null,
        config.onboardingStep ?? null,
        now,
        userId
      );
      return this.getBotConfig(userId)!;
    }

    this.db.prepare(`
      INSERT INTO bot_config (user_id, bot_name, personality_id, custom_personality, model_id, timezone, onboarding_complete, onboarding_step, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      config.botName ?? 'ScallopBot',
      config.personalityId ?? 'friendly',
      config.customPersonality ?? null,
      config.modelId ?? 'moonshot-v1-128k',
      config.timezone ?? 'UTC',
      config.onboardingComplete ? 1 : 0,
      config.onboardingStep ?? 'welcome',
      config.createdAt ?? now,
      now
    );
    return this.getBotConfig(userId)!;
  }

  deleteBotConfig(userId: string): boolean {
    const result = this.db.prepare('DELETE FROM bot_config WHERE user_id = ?').run(userId);
    return result.changes > 0;
  }

  // ============ Cost Usage Operations ============

  recordCostUsage(record: Omit<CostUsageRow, 'id'>): CostUsageRow {
    const stmt = this.db.prepare(`
      INSERT INTO cost_usage (model, provider, session_id, input_tokens, output_tokens, cost, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      record.model, record.provider, record.sessionId,
      record.inputTokens, record.outputTokens, record.cost, record.timestamp
    );
    return { ...record, id: Number(result.lastInsertRowid) };
  }

  getCostUsageSince(sinceMs: number): CostUsageRow[] {
    const stmt = this.db.prepare('SELECT * FROM cost_usage WHERE timestamp >= ? ORDER BY timestamp');
    const rows = stmt.all(sinceMs) as Record<string, unknown>[];
    return rows.map(row => this.rowToCostUsage(row));
  }

  getCostUsageBySession(sessionId: string): CostUsageRow[] {
    const stmt = this.db.prepare('SELECT * FROM cost_usage WHERE session_id = ? ORDER BY timestamp');
    const rows = stmt.all(sessionId) as Record<string, unknown>[];
    return rows.map(row => this.rowToCostUsage(row));
  }

  // ============ Scheduled Items (Unified Triggers + Reminders) ============

  /**
   * Add a scheduled item (trigger or reminder)
   * Status defaults to 'pending' if not specified
   */
  addScheduledItem(item: Omit<ScheduledItem, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'firedAt' | 'kind' | 'taskConfig' | 'boardStatus' | 'priority' | 'labels' | 'result' | 'dependsOn' | 'goalId' | 'workerId' | 'preferredWorkerId' | 'leaseToken' | 'leasedAt' | 'leaseExpiresAt' | 'attemptCount' | 'maxAttempts' | 'lastError' | 'handedOffFrom' | 'messageProvenance' | 'sourceItemId'> & { status?: ScheduledItemStatus; kind?: ScheduledItemKind; taskConfig?: TaskConfig | null; boardStatus?: BoardStatus | null; priority?: Priority; labels?: string[] | null; dependsOn?: string[] | null; goalId?: string | null; preferredWorkerId?: string | null; maxAttempts?: number; messageProvenance?: ScheduledMessageProvenance; sourceItemId?: string | null }): ScheduledItem {
    const kind = item.kind ?? 'nudge';
    const durableMessage = normalizePendingTaskMessage(item.message, kind, item.taskConfig);
    if (item.recurring) validateRecurringSchedule(item.recurring, durableMessage);
    const id = nanoid();
    const now = Date.now();
    const status = item.status ?? (
      item.boardStatus === 'in_progress' ? 'processing'
        : item.boardStatus === 'done' ? 'fired'
          : item.boardStatus === 'archived' ? 'dismissed'
            : 'pending'
    );
    const boardStatus = item.boardStatus ?? (
      status === 'processing' ? 'in_progress'
        : status === 'blocked' ? 'waiting'
        : status === 'fired' || status === 'acted' ? 'done'
          : status === 'dismissed' || status === 'expired' || status === 'failed' ? 'archived'
            : item.triggerAt > 0 ? 'scheduled' : 'inbox'
    );
    const messageProvenance: ScheduledMessageProvenance = item.source === 'user'
      && item.messageProvenance === 'user_literal'
      ? 'user_literal'
      : 'generated';

    // Pre-creation dedup gate (agent-source only). Prevents the cognitive
    // layer from inserting near-duplicate items in a single planning burst —
    // the most common cause of duplicate proactive messages. User-source
    // items (explicit reminders the user set) are never blocked here.
    if (item.source === 'agent') {
      const existing = this.findSimilarAgentScheduledItem(
        item.userId,
        durableMessage,
        item.triggerAt,
        item.sourceItemId ?? null,
      );
      if (existing) {
        return existing;
      }
    }

    if (item.goalId) {
      this.ensureScheduledGoalReference(
        item.goalId,
        item.userId,
        durableMessage,
        kind,
      );
    }

    const stmt = this.db.prepare(`
      INSERT INTO scheduled_items (
        id, user_id, session_id, source, kind, type, message, message_provenance, context,
        trigger_at, recurring, status, source_memory_id, source_item_id, fired_at,
        task_config, board_status, priority, labels, depends_on, goal_id,
        worker_id, preferred_worker_id, lease_token, leased_at, lease_expires_at,
        attempt_count, max_attempts, last_error, handed_off_from,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      item.userId,
      item.sessionId ?? null,
      item.source,
      kind,
      item.type,
      durableMessage,
      messageProvenance,
      item.context ?? null,
      item.triggerAt,
      item.recurring ? JSON.stringify(item.recurring) : null,
      status,
      item.sourceMemoryId ?? null,
      item.sourceItemId ?? null,
      null,
      item.taskConfig ? JSON.stringify(item.taskConfig) : null,
      boardStatus,
      item.priority ?? 'medium',
      item.labels ? JSON.stringify(item.labels) : null,
      item.dependsOn ? JSON.stringify(item.dependsOn) : null,
      item.goalId ?? null,
      null,
      item.preferredWorkerId ?? null,
      null,
      null,
      null,
      0,
      Math.max(1, Math.floor(item.maxAttempts ?? item.taskConfig?.maxAttempts ?? 3)),
      null,
      null,
      now,
      now
    );

    return {
      ...item,
      message: durableMessage,
      id,
      messageProvenance,
      sourceItemId: item.sourceItemId ?? null,
      kind,
      taskConfig: item.taskConfig ?? null,
      boardStatus,
      priority: item.priority ?? 'medium',
      labels: item.labels ?? null,
      result: null,
      dependsOn: item.dependsOn ?? null,
      goalId: item.goalId ?? null,
      workerId: null,
      preferredWorkerId: item.preferredWorkerId ?? null,
      leaseToken: null,
      leasedAt: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      maxAttempts: Math.max(1, Math.floor(item.maxAttempts ?? item.taskConfig?.maxAttempts ?? 3)),
      lastError: null,
      handedOffFrom: null,
      status,
      firedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Get a scheduled item by ID
   */
  getScheduledItem(id: string): ScheduledItem | null {
    const stmt = this.db.prepare('SELECT * FROM scheduled_items WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToScheduledItem(row) : null;
  }

  /**
   * Get pending items that are due (trigger_at <= now)
   */
  getDueScheduledItems(now: number = Date.now()): ScheduledItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE status = 'pending' AND trigger_at > 0 AND trigger_at <= ?
      ORDER BY trigger_at ASC
    `);
    const rows = stmt.all(now) as Record<string, unknown>[];
    return rows.map(row => this.rowToScheduledItem(row));
  }

  /**
   * Users with durable board tasks eligible for leasing now. Unlike nudges,
   * task rows intentionally use trigger_at=0 to mean "ready whenever a worker
   * is available". Keeping this query separate prevents unscheduled inbox
   * nudges from crossing the delivery boundary.
   */
  getReadyBoardTaskUserIds(now: number = Date.now()): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT user_id
      FROM scheduled_items
      WHERE kind = 'task' AND status = 'pending'
        AND board_status IN ('inbox', 'backlog', 'scheduled', 'waiting')
        AND (trigger_at = 0 OR trigger_at <= ?)
        AND (result IS NOT NULL OR attempt_count < max_attempts)
        -- An ordinary zero-time backlog card is planning state, not executable
        -- work. Scheduler eligibility requires a worker config, a stored result
        -- awaiting delivery, or a real scheduled time for legacy recovery.
        AND (task_config IS NOT NULL OR result IS NOT NULL OR trigger_at > 0)
        AND lease_token IS NULL
      ORDER BY user_id
    `).all(now) as Array<{ user_id: string }>;
    return rows.map(row => row.user_id);
  }

  /**
   * Atomically claim due items by selecting them AND marking as 'processing'.
   * Uses a transaction to prevent duplicate processing when scheduler ticks overlap.
   */
  claimDueScheduledItems(now: number = Date.now(), kind?: ScheduledItemKind): ScheduledItem[] {
    const selectStmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE status = 'pending' AND trigger_at > 0 AND trigger_at <= ?
        AND (? IS NULL OR kind = ?)
      ORDER BY trigger_at ASC
    `);
    const updateStmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'processing', board_status = 'in_progress', updated_at = ?
      WHERE id = ? AND status = 'pending'
    `);

    // Wrap in an IMMEDIATE transaction so the SELECT+UPDATE is atomic.
    // IMMEDIATE acquires a reserved lock upfront, preventing concurrent
    // transactions from interleaving between our SELECT and UPDATE.
    const claimTransaction = this.db.transaction(() => {
      const rows = selectStmt.all(now, kind ?? null, kind ?? null) as Record<string, unknown>[];
      const claimed: ScheduledItem[] = [];

      for (const row of rows) {
        const result = updateStmt.run(now, row.id);
        if (result.changes > 0) {
          // Override status to reflect the UPDATE we just performed
          const item = this.rowToScheduledItem(row);
          item.status = 'processing';
          item.boardStatus = 'in_progress';
          item.updatedAt = now;
          claimed.push(item);
        }
      }

      return claimed;
    });

    return claimTransaction.immediate();
  }

  /**
   * Recover nudge claims abandoned by a crashed scheduler. `updated_at` is the
   * atomic claim timestamp written by claimDueScheduledItems; a generous
   * timeout keeps a live renderer/delivery safely owned while allowing a
   * genuinely stranded row to become claimable again after restart.
   *
   * Task-kind rows are deliberately excluded because their lease/token
   * lifecycle is reclaimed separately by BoardService.
   */
  reclaimStaleProcessingNudges(
    staleAfterMs: number,
    now: number = Date.now(),
  ): number {
    const cutoff = now - Math.max(1_000, Math.floor(staleAfterMs));
    const result = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'pending', board_status = 'waiting',
          worker_id = NULL, lease_token = NULL, leased_at = NULL,
          lease_expires_at = NULL,
          last_error = COALESCE(last_error, 'Recovered stale scheduler nudge claim'),
          updated_at = ?
      WHERE kind = 'nudge' AND status = 'processing' AND updated_at <= ?
    `).run(now, cutoff);
    return result.changes;
  }

  /**
   * Reset an item back to pending (e.g. after a processing failure)
   */
  resetScheduledItemToPending(id: string): boolean {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'pending', board_status = 'waiting', updated_at = ?
      WHERE id = ? AND status = 'processing'
    `);
    const result = stmt.run(now, id);
    return result.changes > 0;
  }

  /**
   * Retry a claimed nudge with a bounded attempt budget. This prevents a
   * permanently unrenderable generated draft from calling the provider every
   * scheduler tick forever.
   */
  recordScheduledNudgeFailure(
    id: string,
    retryAt: number,
    error: string,
  ): 'retry' | 'expired' | 'unchanged' {
    const now = Date.now();
    const transaction = this.db.transaction((): 'retry' | 'expired' | 'unchanged' => {
      const row = this.db.prepare(`
        SELECT status, attempt_count, max_attempts FROM scheduled_items
        WHERE id = ? AND kind = 'nudge'
      `).get(id) as { status: string; attempt_count: number; max_attempts: number } | undefined;
      if (!row || row.status !== 'processing') return 'unchanged';

      const attemptCount = row.attempt_count + 1;
      if (attemptCount >= row.max_attempts) {
        this.db.prepare(`
          UPDATE scheduled_items
          SET status = 'expired', board_status = 'archived', attempt_count = ?,
              last_error = ?, updated_at = ?
          WHERE id = ? AND status = 'processing'
        `).run(attemptCount, error, now, id);
        return 'expired';
      }

      this.db.prepare(`
        UPDATE scheduled_items
        SET status = 'pending', board_status = 'waiting', trigger_at = ?,
            attempt_count = ?, last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'processing'
      `).run(retryAt, attemptCount, error, now, id);
      return 'retry';
    });
    return transaction.immediate();
  }

  /**
   * Retry a transport failure for an explicit user reminder without exhausting
   * the small safety budget used by generated nudges. attempt_count remains an
   * observable delivery-attempt counter, but max_attempts is intentionally not
   * used as an expiry condition here.
   */
  recordScheduledExplicitDeliveryFailure(
    id: string,
    retryAt: number,
    error: string,
  ): boolean {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'pending', board_status = 'waiting', trigger_at = ?,
          attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
      WHERE id = ? AND kind = 'nudge' AND source = 'user' AND status = 'processing'
    `).run(retryAt, error, now, id);
    return result.changes > 0;
  }

  /**
   * Atomically lease the next dependency-ready board task to a worker.
   * A lease, unlike status='processing' alone, can be safely reclaimed after
   * worker failure without allowing two workers to complete the same attempt.
   */
  claimNextBoardTask(
    userId: string,
    workerId: string,
    leaseMs: number,
    now: number = Date.now(),
    executionConfiguredOnly: boolean = false,
  ): ScheduledItem | null {
    const duration = Math.max(1_000, Math.floor(leaseMs));
    const transaction = this.db.transaction((): ScheduledItem | null => {
      // Make expired, retryable leases eligible before selecting work.
      this.db.prepare(`
        UPDATE scheduled_items
        SET status = 'pending', board_status = 'waiting', worker_id = NULL,
            lease_token = NULL, leased_at = NULL, lease_expires_at = NULL,
            last_error = COALESCE(last_error, 'Worker lease expired'), updated_at = ?
        WHERE kind = 'task' AND status = 'processing'
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
          AND (result IS NOT NULL OR attempt_count < max_attempts)
      `).run(now, now);
      this.db.prepare(`
        UPDATE scheduled_items
        SET status = 'failed', board_status = 'archived', worker_id = NULL,
            lease_token = NULL, leased_at = NULL, lease_expires_at = NULL,
            last_error = COALESCE(last_error, 'Worker lease expired; retry budget exhausted'), updated_at = ?
        WHERE kind = 'task' AND status = 'processing'
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
          AND result IS NULL AND attempt_count >= max_attempts
      `).run(now, now);

      const rows = this.db.prepare(`
        SELECT * FROM scheduled_items
        WHERE user_id = ? AND kind = 'task' AND status = 'pending'
          AND board_status IN ('inbox', 'backlog', 'scheduled', 'waiting')
          AND (trigger_at = 0 OR trigger_at <= ?)
          AND (result IS NOT NULL OR attempt_count < max_attempts)
          AND (? = 0 OR task_config IS NOT NULL OR result IS NOT NULL OR trigger_at > 0)
          AND lease_token IS NULL
          AND (preferred_worker_id IS NULL OR preferred_worker_id = ?)
        ORDER BY
          CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
          created_at ASC
      `).all(userId, now, executionConfiguredOnly ? 1 : 0, workerId) as Record<string, unknown>[];

      for (const row of rows) {
        const candidate = this.rowToScheduledItem(row);
        const dependenciesReady = (candidate.dependsOn ?? []).every((dependencyId) => {
          const dependency = this.getScheduledItem(dependencyId);
          return dependency?.boardStatus === 'done';
        });
        if (!dependenciesReady) continue;

        const leaseToken = nanoid();
        const claimed = this.db.prepare(`
          UPDATE scheduled_items
          SET status = 'processing', board_status = 'in_progress', worker_id = ?,
              lease_token = ?, leased_at = ?, lease_expires_at = ?,
              attempt_count = CASE WHEN result IS NULL THEN attempt_count + 1 ELSE attempt_count END,
              last_error = NULL, updated_at = ?
          WHERE id = ? AND status = 'pending' AND lease_token IS NULL
        `).run(workerId, leaseToken, now, now + duration, now, candidate.id);
        if (claimed.changes > 0) {
          return this.getScheduledItem(candidate.id);
        }
      }
      return null;
    });
    return transaction.immediate();
  }

  /** Extend a live lease. Stale or incorrect tokens cannot revive work. */
  heartbeatBoardTask(
    itemId: string,
    leaseToken: string,
    extendMs: number,
    now: number = Date.now(),
  ): boolean {
    const expiresAt = now + Math.max(1_000, Math.floor(extendMs));
    const result = this.db.prepare(`
      UPDATE scheduled_items
      SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ?
        AND lease_expires_at > ?
    `).run(expiresAt, now, itemId, leaseToken, now);
    return result.changes > 0;
  }

  /** Persist an intermediate result only while this worker still owns the lease. */
  storeBoardTaskLeaseResult(
    itemId: string,
    leaseToken: string,
    result: BoardItemResult,
    now: number = Date.now(),
  ): boolean {
    const updated = this.db.prepare(`
      UPDATE scheduled_items
      SET result = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ?
        AND lease_expires_at > ?
    `).run(JSON.stringify(result), now, itemId, leaseToken, now);
    return updated.changes > 0;
  }

  /**
   * Release a live lease back to waiting without discarding a computed result.
   * Administrative deferrals (for example quiet hours) can restore the attempt
   * because no worker execution actually occurred.
   */
  deferBoardTaskLease(
    itemId: string,
    leaseToken: string,
    retryAt: number,
    options: { reason?: string; restoreAttempt?: boolean } = {},
    now: number = Date.now(),
  ): boolean {
    const updated = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'pending', board_status = 'waiting', trigger_at = ?,
          worker_id = NULL, lease_token = NULL, leased_at = NULL,
          lease_expires_at = NULL, last_error = ?,
          attempt_count = CASE WHEN ? = 1 THEN MAX(0, attempt_count - 1) ELSE attempt_count END,
          updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ?
        AND lease_expires_at > ?
    `).run(
      Math.max(now, retryAt),
      options.reason ?? null,
      options.restoreAttempt ? 1 : 0,
      now,
      itemId,
      leaseToken,
      now,
    );
    return updated.changes > 0;
  }

  /** Complete a leased task exactly once. */
  completeBoardTaskLease(
    itemId: string,
    leaseToken: string,
    result: BoardItemResult,
    now: number = Date.now(),
  ): boolean {
    // A natural-language response is not evidence of completion. Only an
    // explicit successful worker outcome may cross the done/goal boundary.
    if (result.taskComplete !== true || result.outcome !== 'succeeded') return false;
    const updated = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'fired', board_status = 'done', result = ?, fired_at = ?,
          worker_id = NULL, preferred_worker_id = NULL, lease_token = NULL,
          leased_at = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ?
        AND lease_expires_at > ?
    `).run(JSON.stringify(result), now, now, itemId, leaseToken, now);
    return updated.changes > 0;
  }

  /**
   * Fail a leased attempt. Retryable tasks return to waiting with backoff;
   * exhausted or non-retryable tasks are archived with their error retained.
   */
  failBoardTaskLease(
    itemId: string,
    leaseToken: string,
    error: string,
    options: {
      retryable?: boolean;
      retryAt?: number;
      result?: BoardItemResult;
      failureCode?: string;
    } = {},
    now: number = Date.now(),
  ): 'retry_scheduled' | 'exhausted' | 'stale_lease' {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM scheduled_items
        WHERE id = ? AND status = 'processing' AND lease_token = ?
          AND lease_expires_at > ?
      `).get(itemId, leaseToken, now) as Record<string, unknown> | undefined;
      if (!row) return 'stale_lease' as const;

      const item = this.rowToScheduledItem(row);
      const retryable = options.retryable !== false && item.attemptCount < item.maxAttempts;
      if (retryable) {
        const retryAt = Math.max(now, options.retryAt ?? now);
        this.db.prepare(`
          UPDATE scheduled_items
          SET status = 'pending', board_status = 'waiting', trigger_at = ?,
              worker_id = NULL, lease_token = NULL, leased_at = NULL,
              lease_expires_at = NULL, last_error = ?, updated_at = ?
          WHERE id = ? AND lease_token = ?
        `).run(retryAt, error, now, itemId, leaseToken);
        return 'retry_scheduled' as const;
      }

      const failureResult: BoardItemResult = options.result ?? {
        response: `Error: ${error}`,
        completedAt: now,
        taskComplete: false,
        outcome: 'failed',
        failureCode: options.failureCode ?? 'task_execution_failed',
      };
      this.db.prepare(`
        UPDATE scheduled_items
        SET status = 'failed', board_status = 'archived', result = ?,
            worker_id = NULL, lease_token = NULL, leased_at = NULL,
            lease_expires_at = NULL, last_error = ?, updated_at = ?
        WHERE id = ? AND lease_token = ?
      `).run(JSON.stringify(failureResult), error, now, itemId, leaseToken);
      return 'exhausted' as const;
    });
    return transaction.immediate();
  }

  /** Pause a live task without making it claimable again. */
  blockBoardTaskLease(
    itemId: string,
    leaseToken: string,
    reason: string,
    result: BoardItemResult,
    now: number = Date.now(),
  ): boolean {
    const blockedResult: BoardItemResult = {
      ...result,
      taskComplete: false,
      outcome: 'blocked',
    };
    const updated = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'blocked', board_status = 'waiting', result = ?,
          worker_id = NULL, lease_token = NULL, leased_at = NULL,
          lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ?
        AND lease_expires_at > ?
    `).run(JSON.stringify(blockedResult), reason, now, itemId, leaseToken, now);
    return updated.changes > 0;
  }

  /** Expire a missed occurrence while preserving why no worker ran. */
  expireBoardTaskLease(
    itemId: string,
    leaseToken: string,
    reason: string,
    result: BoardItemResult,
    now: number = Date.now(),
  ): boolean {
    const updated = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'expired', board_status = 'archived', result = ?,
          worker_id = NULL, lease_token = NULL, leased_at = NULL,
          lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ?
        AND lease_expires_at > ?
    `).run(JSON.stringify(result), reason, now, itemId, leaseToken, now);
    return updated.changes > 0;
  }

  /**
   * Persist an identical runtime-failure streak across retries and successor
   * rows in a recurring series. Opening and notification reservation happen in
   * one transaction so restarts or competing schedulers cannot resurrect the
   * loop or send duplicate pause notices.
   */
  recordRecurringTaskFailure(
    item: ScheduledItem,
    error: string,
    failureCode?: string,
    forceOpen: boolean = false,
    now: number = Date.now(),
  ): RecurringTaskFailureCircuitResult | null {
    if (!item.recurring || !item.taskConfig?.goal) return null;
    const seriesKey = recurringTaskSeriesKey(item);
    const fingerprint = recurringFailureFingerprint(error, failureCode);
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT failure_fingerprint, failure_count, opened_at, notification_reserved_at
        FROM recurring_task_failure_circuits WHERE series_key = ?
      `).get(seriesKey) as {
        failure_fingerprint: string;
        failure_count: number;
        opened_at: number | null;
        notification_reserved_at: number | null;
      } | undefined;
      const sameFailure = existing?.failure_fingerprint === fingerprint;
      const failureCount = sameFailure ? existing.failure_count + 1 : 1;
      let openedAt = sameFailure ? existing.opened_at : null;
      let notificationReservedAt = sameFailure ? existing.notification_reserved_at : null;
      if (openedAt == null && (forceOpen || failureCount >= 2)) openedAt = now;
      const shouldNotify = openedAt != null && notificationReservedAt == null;
      if (shouldNotify) notificationReservedAt = now;

      this.db.prepare(`
        INSERT INTO recurring_task_failure_circuits (
          series_key, failure_fingerprint, failure_count, opened_at,
          notification_reserved_at, last_failure_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(series_key) DO UPDATE SET
          failure_fingerprint = excluded.failure_fingerprint,
          failure_count = excluded.failure_count,
          opened_at = excluded.opened_at,
          notification_reserved_at = excluded.notification_reserved_at,
          last_failure_at = excluded.last_failure_at,
          updated_at = excluded.updated_at
      `).run(
        seriesKey,
        fingerprint,
        failureCount,
        openedAt,
        notificationReservedAt,
        now,
        now,
      );
      return {
        seriesKey,
        fingerprint,
        failureCount,
        opened: openedAt != null,
        shouldNotify,
      } satisfies RecurringTaskFailureCircuitResult;
    });
    return transaction.immediate();
  }

  /** Prevent newly-created successor rows from bypassing an open series circuit. */
  isRecurringTaskFailureCircuitOpen(item: ScheduledItem): boolean {
    if (!item.recurring || !item.taskConfig?.goal) return false;
    const row = this.db.prepare(`
      SELECT 1 FROM recurring_task_failure_circuits
      WHERE series_key = ? AND opened_at IS NOT NULL
    `).get(recurringTaskSeriesKey(item));
    return row != null;
  }

  /** A verified worker success starts the series with a clean failure streak. */
  resetRecurringTaskFailureCircuit(item: ScheduledItem): boolean {
    if (!item.recurring || !item.taskConfig?.goal) return false;
    return this.db.prepare(
      'DELETE FROM recurring_task_failure_circuits WHERE series_key = ?',
    ).run(recurringTaskSeriesKey(item)).changes > 0;
  }

  /**
   * Circuit-break pending siblings in the same recurring task series after a
   * permanent capability failure. Returns the number of additional rows paused.
   */
  pauseRecurringTaskSeries(item: ScheduledItem, reason: string, now: number = Date.now()): number {
    if (!item.recurring || !item.taskConfig?.goal) return 0;
    const resultPayload: BoardItemResult = {
      response: 'This recurring task is paused after repeated or exhausted runtime failures.',
      completedAt: now,
      taskComplete: false,
      outcome: 'blocked',
      failureCode: 'recurring_runtime_circuit_open',
    };
    const result = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'blocked', board_status = 'waiting',
          result = COALESCE(result, ?), last_error = ?, updated_at = ?
      WHERE user_id = ? AND kind = 'task' AND status = 'pending'
        AND recurring IS NOT NULL AND json_valid(recurring)
        AND json_extract(recurring, '$.type') = ?
        AND json_extract(recurring, '$.hour') = ?
        AND json_extract(recurring, '$.minute') = ?
        AND COALESCE(json_extract(recurring, '$.dayOfWeek'), -1) = ?
        AND COALESCE(json_extract(recurring, '$.dayOfMonth'), -1) = ?
        AND task_config IS NOT NULL AND json_valid(task_config)
        AND json_extract(task_config, '$.goal') = ?
    `).run(
      JSON.stringify(resultPayload),
      reason,
      now,
      item.userId,
      item.recurring.type,
      item.recurring.hour,
      item.recurring.minute,
      item.recurring.dayOfWeek ?? -1,
      item.recurring.dayOfMonth ?? -1,
      item.taskConfig.goal,
    );
    return result.changes;
  }

  /** Release a live task to a named worker while retaining its audit trail. */
  handoffBoardTask(
    itemId: string,
    leaseToken: string,
    targetWorkerId: string,
    reason?: string,
    now: number = Date.now(),
  ): boolean {
    const row = this.db.prepare(
      'SELECT worker_id FROM scheduled_items WHERE id = ? AND status = ? AND lease_token = ? AND lease_expires_at > ?',
    ).get(itemId, 'processing', leaseToken, now) as { worker_id: string | null } | undefined;
    if (!row) return false;
    const updated = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'pending', board_status = 'waiting', preferred_worker_id = ?,
          handed_off_from = ?, worker_id = NULL, lease_token = NULL,
          leased_at = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ? AND lease_expires_at > ?
    `).run(targetWorkerId, row.worker_id, reason ?? null, now, itemId, leaseToken, now);
    return updated.changes > 0;
  }

  /** Reclaim every expired task lease; returns the number transitioned. */
  reclaimExpiredBoardTaskLeases(now: number = Date.now()): number {
    const transaction = this.db.transaction(() => {
      // Upgrade/restart recovery: the former scheduler marked tasks processing
      // without a lease token. No live durable worker can own such a row.
      const legacyUnleased = this.db.prepare(`
        UPDATE scheduled_items
        SET status = 'pending', board_status = 'waiting', worker_id = NULL,
            leased_at = NULL, lease_expires_at = NULL,
            last_error = COALESCE(last_error, 'Legacy unleased task reclaimed'), updated_at = ?
        WHERE kind = 'task' AND status = 'processing' AND lease_token IS NULL
      `).run(now).changes;
      const retryable = this.db.prepare(`
        UPDATE scheduled_items
        SET status = 'pending', board_status = 'waiting', worker_id = NULL,
            lease_token = NULL, leased_at = NULL, lease_expires_at = NULL,
            last_error = COALESCE(last_error, 'Worker lease expired'), updated_at = ?
        WHERE kind = 'task' AND status = 'processing'
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
          AND (result IS NOT NULL OR attempt_count < max_attempts)
      `).run(now, now).changes;
      const exhausted = this.db.prepare(`
        UPDATE scheduled_items
        SET status = 'failed', board_status = 'archived', worker_id = NULL,
            lease_token = NULL, leased_at = NULL, lease_expires_at = NULL,
            last_error = COALESCE(last_error, 'Worker lease expired; retry budget exhausted'), updated_at = ?
        WHERE kind = 'task' AND status = 'processing'
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
          AND result IS NULL AND attempt_count >= max_attempts
      `).run(now, now).changes;
      return legacyUnleased + retryable + exhausted;
    });
    return transaction.immediate();
  }

  /**
   * Get all scheduled items for a user (all statuses)
   */
  getScheduledItemsByUser(userId: string): ScheduledItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE user_id = ?
      ORDER BY trigger_at ASC
    `);
    const rows = stmt.all(userId) as Record<string, unknown>[];
    return rows.map(row => this.rowToScheduledItem(row));
  }

  /**
   * Get all pending items for a user
   */
  getPendingScheduledItemsByUser(userId: string): ScheduledItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE user_id = ? AND status = 'pending'
      ORDER BY trigger_at ASC
    `);
    const rows = stmt.all(userId) as Record<string, unknown>[];
    return rows.map(row => this.rowToScheduledItem(row));
  }

  /**
   * Get pending items by source (user or agent)
   */
  getPendingScheduledItemsBySource(userId: string, source: ScheduledItemSource): ScheduledItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE user_id = ? AND source = ? AND status = 'pending'
      ORDER BY trigger_at ASC
    `);
    const rows = stmt.all(userId, source) as Record<string, unknown>[];
    return rows.map(row => this.rowToScheduledItem(row));
  }

  /**
   * Mark a scheduled item as fired
   */
  markScheduledItemFired(id: string): boolean {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'fired', board_status = 'done', fired_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'processing')
    `);
    const result = stmt.run(now, now, id);
    return result.changes > 0;
  }

  /**
   * Mark a scheduled item as dismissed
   */
  markScheduledItemDismissed(id: string): boolean {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'dismissed', board_status = 'archived', updated_at = ?
      WHERE id = ?
    `);
    const result = stmt.run(now, id);
    return result.changes > 0;
  }

  /**
   * Close an inferred item that became stale/resolved without pretending it
   * was delivered or dismissed by the user. Expired items do not influence
   * proactive cooldown or trust feedback.
   */
  markScheduledItemExpired(id: string): boolean {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'expired', board_status = 'archived', updated_at = ?
      WHERE id = ? AND status IN ('pending', 'processing')
    `).run(now, id);
    return result.changes > 0;
  }

  /**
   * Mark a scheduled item as acted (user engaged with proactive message)
   */
  markScheduledItemActed(id: string): boolean {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'acted', board_status = 'done', updated_at = ?
      WHERE id = ?
    `);
    const result = stmt.run(now, id);
    return result.changes > 0;
  }

  /**
   * Append exact channel delivery provenance for every transport chunk.
   * Rows are never updated or deleted; duplicate retries are idempotently
   * ignored while an ambiguity marker may be appended conservatively later.
   */
  recordProactiveDeliveryReceipt(input: {
    channel: string;
    channelMessageIds: string[];
    scheduledItemId: string;
    ownerUserId: string;
    ambiguous?: boolean;
    createdAt?: number;
  }): number {
    const channel = input.channel.trim().toLowerCase();
    const scheduledItemId = input.scheduledItemId.trim();
    const ownerUserId = input.ownerUserId.trim();
    const channelMessageIds = [...new Set(
      input.channelMessageIds.map(messageId => messageId.trim()).filter(Boolean),
    )];
    if (!channel || !scheduledItemId || !ownerUserId || channelMessageIds.length === 0) return 0;

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO proactive_delivery_receipts (
        channel, channel_message_id, scheduled_item_id, owner_user_id, ambiguous, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const createdAt = input.createdAt ?? Date.now();
    const append = this.db.transaction(() => {
      let inserted = 0;
      for (const messageId of channelMessageIds) {
        inserted += insert.run(
          channel,
          messageId,
          scheduledItemId,
          ownerUserId,
          input.ambiguous ? 1 : 0,
          createdAt,
        ).changes;
      }
      return inserted;
    });
    return append.immediate();
  }

  /** Return all append-only claims for one channel-scoped message ID. */
  getProactiveDeliveryReceipts(
    channel: string,
    channelMessageId: string,
  ): ProactiveDeliveryReceiptRow[] {
    const rows = this.db.prepare(`
      SELECT id, channel, channel_message_id, scheduled_item_id,
             owner_user_id, ambiguous, created_at
      FROM proactive_delivery_receipts
      WHERE channel = ? AND channel_message_id = ?
      ORDER BY id ASC
    `).all(channel.trim().toLowerCase(), channelMessageId.trim()) as Array<{
      id: number;
      channel: string;
      channel_message_id: string;
      scheduled_item_id: string;
      owner_user_id: string;
      ambiguous: number;
      created_at: number;
    }>;
    return rows.map(row => ({
      id: row.id,
      channel: row.channel,
      channelMessageId: row.channel_message_id,
      scheduledItemId: row.scheduled_item_id,
      ownerUserId: row.owner_user_id,
      ambiguous: row.ambiguous === 1,
      createdAt: row.created_at,
    }));
  }

  /**
   * Atomically apply a trusted direct-reply action to a linked source, close
   * the delivered wrapper, and write both feedback decisions. The wrapper ID
   * is the idempotency key: retries return the first deterministic outcome and
   * can never extend a Snooze twice.
   */
  applyLinkedSourceReplyAndAcknowledge(input: {
    wrapperId: string;
    sourceItemId: string;
    ownerUserId: string;
    feedbackUserId: string;
    action: ProactiveSourceReplyAction;
    delayMs?: number;
    score: number;
    now?: number;
  }): ProactiveSourceReplyTransactionResult {
    const now = input.now ?? Date.now();
    const transaction = this.db.transaction((): ProactiveSourceReplyTransactionResult => {
      const existing = this.db.prepare(`
        SELECT action, source_title, applied
        FROM proactive_source_reply_actions
        WHERE wrapper_id = ?
      `).get(input.wrapperId) as {
        action: ProactiveSourceReplyAction;
        source_title: string;
        applied: number;
      } | undefined;
      if (existing) {
        return {
          acknowledged: true,
          replayed: true,
          sourceAction: existing.applied === 1
            ? { action: existing.action, title: existing.source_title, applied: true }
            : null,
        };
      }

      const wrapper = this.db.prepare(`
        SELECT id, user_id, status
        FROM scheduled_items
        WHERE id = ? AND user_id = ?
      `).get(input.wrapperId, input.ownerUserId) as {
        id: string;
        user_id: string;
        status: string;
      } | undefined;
      if (!wrapper) {
        return { acknowledged: false, replayed: false, sourceAction: null };
      }

      const source = this.db.prepare(`
        SELECT * FROM scheduled_items
        WHERE id = ? AND id != ? AND user_id = ?
      `).get(input.sourceItemId, input.wrapperId, input.ownerUserId) as Record<string, unknown> | undefined;

      let applied = false;
      const sourceTitle = source ? String(source.message) : '';
      let resultingTriggerAt: number | null = source ? Number(source.trigger_at) : null;

      // Exact delivery provenance may arrive before the scheduler flips a
      // processing wrapper to fired, and a conversational acknowledgement may
      // mark it acted before a later explicit Archive/Done/Snooze. The action
      // ledger remains the idempotency gate; dismissed/expired wrappers stay
      // terminal and cannot acquire a new side effect retroactively.
      if (source && ['processing', 'fired', 'acted'].includes(wrapper.status)) {
        const status = String(source.status);
        const boardStatus = source.board_status == null ? null : String(source.board_status);
        const terminal = status === 'fired' || status === 'acted'
          || status === 'dismissed' || status === 'expired';
        const hasLiveLease = status === 'processing'
          && source.lease_token != null
          && Number(source.lease_expires_at ?? 0) > now;

        if (input.action === 'archive' && (
          boardStatus === 'archived' || status === 'dismissed' || status === 'expired'
        )) {
          applied = true;
        } else if (input.action === 'done' && (
          boardStatus === 'done' || status === 'fired' || status === 'acted'
        )) {
          applied = true;
        } else if (!hasLiveLease && boardStatus !== 'done' && boardStatus !== 'archived') {
          if (input.action === 'archive') {
            // Preserve legacy terminal history; otherwise atomically archive.
            if (terminal) {
              applied = status === 'dismissed' || status === 'expired';
            } else {
              applied = this.db.prepare(`
                UPDATE scheduled_items
                SET status = 'dismissed', board_status = 'archived',
                    worker_id = NULL, lease_token = NULL, leased_at = NULL,
                    lease_expires_at = NULL, updated_at = ?
                WHERE id = ? AND user_id = ?
              `).run(now, input.sourceItemId, input.ownerUserId).changes === 1;
            }
          } else if (input.action === 'done' && !terminal) {
            applied = this.db.prepare(`
              UPDATE scheduled_items
              SET status = 'fired', board_status = 'done', fired_at = COALESCE(fired_at, ?),
                  worker_id = NULL, lease_token = NULL, leased_at = NULL,
                  lease_expires_at = NULL, updated_at = ?
              WHERE id = ? AND user_id = ?
            `).run(now, now, input.sourceItemId, input.ownerUserId).changes === 1;
          } else if (input.action === 'snooze' && !terminal) {
            resultingTriggerAt = now + Math.max(60_000, Math.floor(input.delayMs ?? 24 * 60 * 60 * 1000));
            applied = this.db.prepare(`
              UPDATE scheduled_items
              SET status = 'pending', board_status = 'scheduled', trigger_at = ?,
                  worker_id = NULL, lease_token = NULL, leased_at = NULL,
                  lease_expires_at = NULL, updated_at = ?
              WHERE id = ? AND user_id = ?
            `).run(resultingTriggerAt, now, input.sourceItemId, input.ownerUserId).changes === 1;
          }
        }
      }

      this.db.prepare(`
        INSERT INTO proactive_source_reply_actions (
          wrapper_id, source_item_id, user_id, action, source_title,
          applied, source_trigger_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.wrapperId,
        input.sourceItemId,
        input.ownerUserId,
        input.action,
        sourceTitle,
        applied ? 1 : 0,
        resultingTriggerAt,
        now,
      );

      this.db.prepare(`
        UPDATE scheduled_items
        SET status = 'acted', board_status = 'done', updated_at = ?
        WHERE id = ? AND user_id = ? AND status IN ('processing', 'fired')
      `).run(now, input.wrapperId, input.ownerUserId);

      if (applied && source) {
        this.db.prepare(`
          INSERT INTO proactive_decisions (user_id, at, stage, outcome, reason, detail)
          VALUES (?, ?, 'feedback', 'source_updated', ?, ?)
        `).run(
          input.feedbackUserId,
          now,
          `reply_${input.action}`,
          JSON.stringify({ itemId: input.wrapperId, sourceItemId: input.sourceItemId }),
        );
      }
      this.db.prepare(`
        INSERT INTO proactive_decisions (user_id, at, stage, outcome, reason, detail)
        VALUES (?, ?, 'feedback', 'acted', 'direct_reply', ?)
      `).run(
        input.feedbackUserId,
        now,
        JSON.stringify({
          itemId: input.wrapperId,
          score: input.score,
          replyAction: input.action,
          sourceActionApplied: applied,
        }),
      );

      return {
        acknowledged: true,
        replayed: false,
        sourceAction: applied && source
          ? { action: input.action, title: sourceTitle, applied: true }
          : null,
      };
    });

    return transaction.immediate();
  }

  /**
   * Update a scheduled item (e.g., reschedule)
   */
  updateScheduledItem(id: string, updates: Partial<Pick<ScheduledItem, 'triggerAt' | 'message' | 'messageProvenance' | 'status'>>): boolean {
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (updates.triggerAt !== undefined) {
      sets.push('trigger_at = ?');
      params.push(updates.triggerAt);
    }
    if (updates.message !== undefined) {
      sets.push('message = ?');
      params.push(updates.message);
      sets.push("message_provenance = CASE WHEN source = 'user' THEN ? ELSE 'generated' END");
      params.push(updates.messageProvenance ?? 'generated');
    }
    if (updates.status !== undefined) {
      sets.push('status = ?');
      params.push(updates.status);
      sets.push(`board_status = CASE ?
        WHEN 'processing' THEN 'in_progress'
        WHEN 'blocked' THEN 'waiting'
        WHEN 'fired' THEN 'done'
        WHEN 'acted' THEN 'done'
        WHEN 'dismissed' THEN 'archived'
        WHEN 'expired' THEN 'archived'
        WHEN 'failed' THEN 'archived'
        ELSE CASE
          WHEN board_status IN ('inbox', 'backlog', 'scheduled', 'waiting') THEN board_status
          WHEN COALESCE(?, trigger_at) > 0 THEN 'scheduled'
          ELSE 'inbox'
        END
      END`);
      params.push(updates.status, updates.triggerAt ?? null);
    }

    params.push(id);
    // SAFETY: Column names in `sets` are hardcoded strings from the conditionals above, never user-derived
    const stmt = this.db.prepare(`UPDATE scheduled_items SET ${sets.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);
    return result.changes > 0;
  }

  /**
   * Repair a leased legacy/malformed task that has no execution configuration.
   * It is deliverable reminder text, not unattended work. The active lease is
   * retained so the same scheduler can finish delivery exactly once.
   */
  reclassifyLeasedTaskAsNudge(id: string, leaseToken: string): boolean {
    const result = this.db.prepare(`
      UPDATE scheduled_items
      SET kind = 'nudge', type = 'reminder', updated_at = ?
      WHERE id = ? AND kind = 'task' AND task_config IS NULL
        AND status = 'processing' AND lease_token = ?
    `).run(Date.now(), id, leaseToken);
    return result.changes === 1;
  }

  /**
   * Update board-specific fields on a scheduled item
   */
  updateScheduledItemBoard(id: string, updates: {
    boardStatus?: BoardStatus | null;
    priority?: Priority;
    labels?: string[] | null;
    triggerAt?: number;
    message?: string;
    messageProvenance?: ScheduledMessageProvenance;
    kind?: ScheduledItemKind;
    goalId?: string | null;
    dependsOn?: string[] | null;
    status?: ScheduledItemStatus;
  }): boolean {
    const now = Date.now();
    if (updates.goalId) {
      const current = this.getScheduledItem(id);
      if (!current) return false;
      this.ensureScheduledGoalReference(
        updates.goalId,
        current.userId,
        updates.message ?? current.message,
        updates.kind ?? current.kind,
      );
    }
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (updates.boardStatus !== undefined) {
      sets.push('board_status = ?');
      params.push(updates.boardStatus);
    }
    if (updates.priority !== undefined) {
      sets.push('priority = ?');
      params.push(updates.priority);
    }
    if (updates.labels !== undefined) {
      sets.push('labels = ?');
      params.push(updates.labels ? JSON.stringify(updates.labels) : null);
    }
    if (updates.triggerAt !== undefined) {
      sets.push('trigger_at = ?');
      params.push(updates.triggerAt);
    }
    if (updates.message !== undefined) {
      sets.push('message = ?');
      params.push(updates.message);
      sets.push("message_provenance = CASE WHEN source = 'user' THEN ? ELSE 'generated' END");
      params.push(updates.messageProvenance ?? 'generated');
    }
    if (updates.kind !== undefined) {
      sets.push('kind = ?');
      params.push(updates.kind);
    }
    if (updates.goalId !== undefined) {
      sets.push('goal_id = ?');
      params.push(updates.goalId);
    }
    if (updates.dependsOn !== undefined) {
      sets.push('depends_on = ?');
      params.push(updates.dependsOn ? JSON.stringify(updates.dependsOn) : null);
    }
    if (updates.status !== undefined) {
      sets.push('status = ?');
      params.push(updates.status);
      if (updates.boardStatus === undefined) {
        sets.push(`board_status = CASE ?
          WHEN 'processing' THEN 'in_progress'
          WHEN 'blocked' THEN 'waiting'
          WHEN 'fired' THEN 'done'
          WHEN 'acted' THEN 'done'
          WHEN 'dismissed' THEN 'archived'
          WHEN 'expired' THEN 'archived'
          WHEN 'failed' THEN 'archived'
          ELSE CASE
            WHEN board_status IN ('inbox', 'backlog', 'scheduled', 'waiting') THEN board_status
            WHEN COALESCE(?, trigger_at) > 0 THEN 'scheduled'
            ELSE 'inbox'
          END
        END`);
        params.push(updates.status, updates.triggerAt ?? null);
      }
    }

    params.push(id);
    const stmt = this.db.prepare(`UPDATE scheduled_items SET ${sets.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);
    return result.changes > 0;
  }

  /**
   * Store a result on a scheduled item (called by scheduler after sub-agent completes)
   */
  updateScheduledItemResult(id: string, result: BoardItemResult): boolean {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE scheduled_items SET result = ?, updated_at = ? WHERE id = ?
    `);
    const res = stmt.run(JSON.stringify(result), now, id);
    return res.changes > 0;
  }

  /**
   * Get scheduled items by board status for a user
   */
  getScheduledItemsByBoardStatus(userId: string, boardStatus: BoardStatus): ScheduledItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE user_id = ? AND board_status = ?
      ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
        trigger_at ASC
    `);
    const rows = stmt.all(userId, boardStatus) as Record<string, unknown>[];
    return rows.map(row => this.rowToScheduledItem(row));
  }

  /**
   * Get all board items for a user (items with board_status set, plus legacy items)
   */
  getScheduledItemsForBoard(userId: string): ScheduledItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE user_id = ? AND status NOT IN ('expired')
      ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
        trigger_at ASC
    `);
    const rows = stmt.all(userId) as Record<string, unknown>[];
    return rows.map(row => this.rowToScheduledItem(row));
  }

  /**
   * Get completed board items that haven't been notified yet
   */
  getUnnotifiedCompletedItems(userId: string): ScheduledItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE user_id = ? AND board_status = 'done' AND result IS NOT NULL
      ORDER BY updated_at ASC
    `);
    const rows = stmt.all(userId) as Record<string, unknown>[];
    return rows.map(row => this.rowToScheduledItem(row))
      .filter(item => item.result && item.result.notifiedAt == null);
  }

  /**
   * Auto-archive done items older than maxAgeMs
   */
  autoArchiveDoneItems(userId: string, maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE scheduled_items
      SET board_status = 'archived', updated_at = ?
      WHERE user_id = ? AND board_status = 'done' AND updated_at < ?
    `);
    const result = stmt.run(now, userId, cutoff);
    return result.changes;
  }

  /**
   * Delete a scheduled item
   */
  deleteScheduledItem(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM scheduled_items WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Consolidate duplicate pending scheduled items.
   * Groups pending items by user, then archives duplicates using word-overlap similarity.
   * Keeps the earliest-created item live in each duplicate group while preserving
   * every duplicate row for audit/history.
   * Returns the number of duplicates archived.
   */
  consolidateDuplicateScheduledItems(): number {
    const stmt = this.db.prepare(`
      SELECT id, user_id, kind, type, source_item_id, source_memory_id,
             message, trigger_at, created_at
      FROM scheduled_items
      WHERE status = 'pending' AND source = 'agent'
      ORDER BY user_id, created_at ASC
    `);
    const rows = stmt.all() as Array<{
      id: string;
      user_id: string;
      kind: string;
      type: string;
      source_item_id: string | null;
      source_memory_id: string | null;
      message: string;
      trigger_at: number;
      created_at: number;
    }>;

    const isSimilar = (a: Set<string>, b: Set<string>): boolean => {
      if (a.size === 0 || b.size === 0) return false;
      let overlap = 0;
      for (const word of a) {
        if (b.has(word)) overlap++;
      }
      const smaller = Math.min(a.size, b.size);
      return (overlap / smaller) >= DEDUP_SIMILARITY_STRICT || (overlap / a.size) >= DEDUP_SIMILARITY_LENIENT || (overlap / b.size) >= DEDUP_SIMILARITY_LENIENT;
    };

    // Provenance and execution shape are part of duplicate identity. Two
    // wrappers can have nearly identical wording while referring to different
    // board tasks; collapsing them would sever reply routing and hide work.
    const byIdentity = new Map<string, typeof rows>();
    for (const row of rows) {
      const identity = JSON.stringify([
        row.user_id,
        row.kind,
        row.type,
        row.source_item_id,
        row.source_memory_id,
      ]);
      const list = byIdentity.get(identity) || [];
      list.push(row);
      byIdentity.set(identity, list);
    }

    const toArchive = new Set<string>();
    const archiveStmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'expired', board_status = 'archived',
          last_error = COALESCE(last_error, 'Archived as a duplicate scheduled item'),
          updated_at = ?
      WHERE id = ? AND status = 'pending'
    `);

    for (const items of byIdentity.values()) {
      const kept = new Set<number>(); // indices we've already decided to keep
      for (let i = 0; i < items.length; i++) {
        if (toArchive.has(items[i].id)) continue;
        kept.add(i);
        const wordsI = normalizeForSimilarity(items[i].message);
        for (let j = i + 1; j < items.length; j++) {
          if (toArchive.has(items[j].id)) continue;
          // Only compare items within 7 days of each other
          if (Math.abs(items[i].trigger_at - items[j].trigger_at) > 7 * 24 * 60 * 60 * 1000) continue;
          const wordsJ = normalizeForSimilarity(items[j].message);
          if (isSimilar(wordsI, wordsJ)) {
            toArchive.add(items[j].id); // keep earlier (i), quarantine later (j)
          }
        }
      }
    }

    const now = Date.now();
    let archived = 0;
    for (const id of toArchive) {
      archived += archiveStmt.run(now, id).changes;
    }

    return archived;
  }

  /**
   * Record a proactive message that was sent to a user. Persists to SQLite so
   * the in-memory dedup history survives process restarts.
   */
  /** Record an LLM diagnostic trace. Content retention is controlled upstream. */
  insertLlmTrace(row: {
    ts: number;
    purpose: string;
    model: string;
    provider: string;
    prompt: string;
    response: string;
    parsedOk: number;
    sessionId: string | null;
    latencyMs: number;
    stopReason?: string;
    requestMaxTokens?: number | null;
    modelContextWindowTokens?: number;
    modelMaxOutputTokens?: number;
  }): void {
    this.db.prepare(`
      INSERT INTO llm_traces (
        ts, purpose, model, provider, prompt, response, parsed_ok, session_id,
        latency_ms, stop_reason, request_max_tokens, model_context_window_tokens,
        model_max_output_tokens
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.ts,
      row.purpose,
      row.model,
      row.provider,
      row.prompt,
      row.response,
      row.parsedOk,
      row.sessionId,
      row.latencyMs,
      row.stopReason ?? null,
      row.requestMaxTokens ?? null,
      row.modelContextWindowTokens ?? null,
      row.modelMaxOutputTokens ?? null
    );

    // Timestamp-based maintenance works across restarts and low-volume bots;
    // an insert counter could stay below its threshold forever.
    if (Date.now() - this.lastRetentionMaintenanceAt >= 60 * 60 * 1000) {
      this.runRetentionMaintenance();
    }
  }

  /** Delete traces older than `cutoffMs`. Returns rows removed. */
  pruneLlmTraces(cutoffMs: number): number {
    return this.db.prepare('DELETE FROM llm_traces WHERE ts < ?').run(cutoffMs).changes as number;
  }

  /**
   * Startup/hourly retention for potentially private diagnostics. Full trace
   * content is opt-in and defaults to a short seven-day window; compact
   * proactive decisions keep a longer configurable diagnostic window.
   */
  runRetentionMaintenance(now: number = Date.now()): {
    tracesDeleted: number;
    proactiveDecisionsDeleted: number;
  } {
    const days = (name: string, fallback: number): number => {
      const parsed = Number(process.env[name]);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };
    const traceDays = days('LLM_TRACE_RETENTION_DAYS', 7);
    const decisionDays = days('PROACTIVE_DECISION_RETENTION_DAYS', 30);
    const dayMs = 24 * 60 * 60 * 1000;
    const tracesDeleted = this.pruneLlmTraces(now - traceDays * dayMs);
    const proactiveDecisionsDeleted = this.pruneProactiveDecisions(now - decisionDays * dayMs);
    this.lastRetentionMaintenanceAt = now;
    return { tracesDeleted, proactiveDecisionsDeleted };
  }

  /** Trace counts by purpose/parse outcome since `sinceMs` (observability). */
  getLlmTraceStats(sinceMs: number): Array<{ purpose: string; parsedOk: number; count: number }> {
    const rows = this.db.prepare(`
      SELECT purpose, parsed_ok, COUNT(*) AS count FROM llm_traces
      WHERE ts >= ? GROUP BY purpose, parsed_ok ORDER BY purpose
    `).all(sinceMs) as Array<{ purpose: string; parsed_ok: number; count: number }>;
    return rows.map(r => ({ purpose: r.purpose, parsedOk: r.parsed_ok, count: r.count }));
  }

  recordProactiveSend(userId: string, message: string, source: string, sentAt: number = Date.now()): void {
    this.db.prepare(`
      INSERT INTO proactive_send_log (user_id, message, source, sent_at)
      VALUES (?, ?, ?, ?)
    `).run(userId, message, source, sentAt);
  }

  /**
   * Atomically reserve one inferred-delivery slot across every process sharing
   * this SQLite database. Active reservations count toward the daily budget and
   * serialize the min-gap window until delivery is finalized or released.
   */
  reserveProactiveDelivery(input: {
    itemId: string;
    userId: string;
    dayStart: number;
    nextDayStart: number;
    dailyCap: number;
    minGapMs: number;
    reservationTtlMs?: number;
    now?: number;
  }): ProactiveDeliveryReservationResult {
    const now = input.now ?? Date.now();
    const ttlMs = Math.max(60_000, Math.floor(input.reservationTtlMs ?? 15 * 60_000));
    const transaction = this.db.transaction((): ProactiveDeliveryReservationResult => {
      this.db.prepare('DELETE FROM proactive_delivery_reservations WHERE expires_at <= ?').run(now);

      const existingItem = this.db.prepare(`
        SELECT expires_at FROM proactive_delivery_reservations
        WHERE item_id = ? AND expires_at > ?
      `).get(input.itemId, now) as { expires_at: number } | undefined;
      if (existingItem) return { outcome: 'min_gap', retryAt: existingItem.expires_at };

      const sentToday = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM proactive_send_log
        WHERE user_id = ? AND source = 'agent' AND sent_at >= ?
      `).get(input.userId, input.dayStart) as { count: number };
      const heldToday = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM proactive_delivery_reservations
        WHERE user_id = ? AND reserved_at >= ? AND expires_at > ?
      `).get(input.userId, input.dayStart, now) as { count: number };
      if (sentToday.count + heldToday.count >= Math.max(1, Math.floor(input.dailyCap))) {
        return { outcome: 'daily_cap', retryAt: input.nextDayStart };
      }

      if (input.minGapMs > 0) {
        const lastSend = this.db.prepare(`
          SELECT MAX(sent_at) AS sent_at
          FROM proactive_send_log
          WHERE user_id = ? AND source = 'agent'
        `).get(input.userId) as { sent_at: number | null };
        const held = this.db.prepare(`
          SELECT MAX(expires_at) AS expires_at
          FROM proactive_delivery_reservations
          WHERE user_id = ? AND expires_at > ?
        `).get(input.userId, now) as { expires_at: number | null };
        const retryAt = Math.max(
          (lastSend.sent_at ?? 0) + input.minGapMs,
          held.expires_at ?? 0,
        );
        if (retryAt > now) return { outcome: 'min_gap', retryAt };
      }

      const token = nanoid();
      this.db.prepare(`
        INSERT INTO proactive_delivery_reservations (
          token, item_id, user_id, reserved_at, expires_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(token, input.itemId, input.userId, now, now + ttlMs);
      return { outcome: 'reserved', token };
    });
    return transaction.immediate();
  }

  /** Release capacity after transport fails or is abandoned before a send. */
  releaseProactiveDeliveryReservation(token: string): boolean {
    return this.db.prepare(`
      DELETE FROM proactive_delivery_reservations WHERE token = ?
    `).run(token).changes === 1;
  }

  /** Convert a held slot into the authoritative send record atomically. */
  finalizeProactiveDeliveryReservation(
    token: string,
    message: string,
    source: string,
    sentAt: number = Date.now(),
  ): boolean {
    const transaction = this.db.transaction(() => {
      const reservation = this.db.prepare(`
        SELECT user_id FROM proactive_delivery_reservations WHERE token = ?
      `).get(token) as { user_id: string } | undefined;
      if (!reservation) return false;
      this.db.prepare(`
        INSERT INTO proactive_send_log (user_id, message, source, sent_at)
        VALUES (?, ?, ?, ?)
      `).run(reservation.user_id, message, source, sentAt);
      this.db.prepare('DELETE FROM proactive_delivery_reservations WHERE token = ?').run(token);
      return true;
    });
    return transaction.immediate();
  }

  /**
   * Load recent proactive sends since `sinceMs` for restart-time dedup hydration.
   * Returns rows for ALL users; the scheduler bucket-sorts them into the
   * per-user in-memory map.
   */
  getRecentProactiveSends(sinceMs: number): Array<{ userId: string; message: string; source: string; sentAt: number }> {
    const rows = this.db.prepare(`
      SELECT user_id, message, source, sent_at
      FROM proactive_send_log
      WHERE sent_at >= ?
      ORDER BY sent_at ASC
    `).all(sinceMs) as Array<{ user_id: string; message: string; source: string; sent_at: number }>;
    return rows.map(r => ({ userId: r.user_id, message: r.message, source: r.source, sentAt: r.sent_at }));
  }

  /**
   * Prune proactive_send_log entries older than `cutoffMs`. Called periodically
   * to keep the table small.
   */
  pruneProactiveSendLog(cutoffMs: number): number {
    const result = this.db.prepare('DELETE FROM proactive_send_log WHERE sent_at < ?').run(cutoffMs);
    return result.changes;
  }

  /**
   * Record a proactive DECISION for observability (powers `why-no-proact`).
   * `detail` is JSON-serialized. Never throws — diagnostics must not break the
   * gardener/scheduler.
   */
  recordProactiveDecision(decision: {
    userId: string;
    stage: string;
    outcome: string;
    reason?: string | null;
    detail?: Record<string, unknown> | null;
    at?: number;
  }): void {
    try {
      this.db.prepare(`
        INSERT INTO proactive_decisions (user_id, at, stage, outcome, reason, detail)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        decision.userId,
        decision.at ?? Date.now(),
        decision.stage,
        decision.outcome,
        decision.reason ?? null,
        decision.detail ? JSON.stringify(decision.detail) : null
      );
    } catch {
      // Observability is best-effort; swallow.
    }
  }

  /**
   * Load the most recent proactive decisions (newest first), for the diagnostic.
   */
  getRecentProactiveDecisions(limit: number = 30): Array<{
    id: number;
    userId: string;
    at: number;
    stage: string;
    outcome: string;
    reason: string | null;
    detail: Record<string, unknown> | null;
  }> {
    const rows = this.db.prepare(`
      SELECT id, user_id, at, stage, outcome, reason, detail
      FROM proactive_decisions
      ORDER BY at DESC
      LIMIT ?
    `).all(limit) as Array<{ id: number; user_id: string; at: number; stage: string; outcome: string; reason: string | null; detail: string | null }>;
    return rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      at: r.at,
      stage: r.stage,
      outcome: r.outcome,
      reason: r.reason,
      detail: r.detail ? parseDetailJSON(r.detail) : null,
    }));
  }

  /**
   * Return the durable evaluation which started the current fingerprint cache
   * window. Cache-hit diagnostics are deliberately excluded: using a later
   * `unchanged_*` row as the anchor would slide the TTL forever and prevent a
   * genuinely fresh evaluation while the underlying signal stayed unchanged.
   */
  getLatestProactiveEvaluationAnchor(userId: string): {
    id: number;
    userId: string;
    at: number;
    stage: string;
    outcome: string;
    reason: string | null;
    detail: Record<string, unknown> | null;
  } | null {
    const row = this.db.prepare(`
      SELECT id, user_id, at, stage, outcome, reason, detail
      FROM proactive_decisions
      WHERE user_id = ?
        AND stage = 'evaluate'
        AND json_type(detail, '$.signalFingerprint') = 'text'
        AND (outcome = 'created' OR reason = 'llm_skipped_all')
      ORDER BY at DESC, id DESC
      LIMIT 1
    `).get(userId) as {
      id: number;
      user_id: string;
      at: number;
      stage: string;
      outcome: string;
      reason: string | null;
      detail: string | null;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      at: row.at,
      stage: row.stage,
      outcome: row.outcome,
      reason: row.reason,
      detail: row.detail ? parseDetailJSON(row.detail) : null,
    };
  }

  /** Prune proactive_decisions older than `cutoffMs`. */
  pruneProactiveDecisions(cutoffMs: number): number {
    const result = this.db.prepare('DELETE FROM proactive_decisions WHERE at < ?').run(cutoffMs);
    return result.changes;
  }

  // ============ Self-Evolution Engine ============

  /** Append a captured improvement signal (Layer 1). Best-effort. */
  recordEvolutionSignal(signal: {
    userId: string;
    at: number;
    type: string;
    targetSkill?: string | null;
    criticScore?: number | null;
    toolCallCount?: number | null;
    sessionId?: string | null;
    detail?: Record<string, unknown> | null;
  }): void {
    try {
      this.db.prepare(`
        INSERT INTO evolution_signals
          (user_id, at, type, target_skill, critic_score, tool_call_count, session_id, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        signal.userId,
        signal.at,
        signal.type,
        signal.targetSkill ?? null,
        signal.criticScore ?? null,
        signal.toolCallCount ?? null,
        signal.sessionId ?? null,
        signal.detail ? JSON.stringify(signal.detail) : null,
      );
    } catch {
      // Observability/corpus capture is best-effort; swallow.
    }
  }

  /** Most recent evolution signals (newest first). */
  getRecentEvolutionSignals(limit: number = 100): Array<{
    id: number;
    userId: string;
    at: number;
    type: string;
    targetSkill: string | null;
    criticScore: number | null;
    toolCallCount: number | null;
    sessionId: string | null;
    detail: Record<string, unknown> | null;
  }> {
    const rows = this.db.prepare(`
      SELECT id, user_id, at, type, target_skill, critic_score, tool_call_count, session_id, detail
      FROM evolution_signals
      ORDER BY at DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: number; user_id: string; at: number; type: string; target_skill: string | null;
      critic_score: number | null; tool_call_count: number | null; session_id: string | null; detail: string | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      at: r.at,
      type: r.type,
      targetSkill: r.target_skill,
      criticScore: r.critic_score,
      toolCallCount: r.tool_call_count,
      sessionId: r.session_id,
      detail: r.detail ? parseDetailJSON(r.detail) : null,
    }));
  }

  /** Prune evolution_signals older than `cutoffMs`. */
  pruneEvolutionSignals(cutoffMs: number): number {
    const result = this.db.prepare('DELETE FROM evolution_signals WHERE at < ?').run(cutoffMs);
    return result.changes;
  }

  /** Append an evolution decision record (observability). Best-effort. */
  recordEvolutionDecision(decision: {
    at: number;
    stage: string;
    outcome: string;
    reason?: string | null;
    target?: string | null;
    detail?: Record<string, unknown> | null;
  }): void {
    try {
      this.db.prepare(`
        INSERT INTO evolution_decisions (at, stage, outcome, reason, target, detail)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        decision.at,
        decision.stage,
        decision.outcome,
        decision.reason ?? null,
        decision.target ?? null,
        decision.detail ? JSON.stringify(decision.detail) : null,
      );
    } catch {
      // Observability is best-effort; swallow.
    }
  }

  /** Most recent evolution decisions (newest first), for the diagnostic. */
  getRecentEvolutionDecisions(limit: number = 30): Array<{
    id: number;
    at: number;
    stage: string;
    outcome: string;
    reason: string | null;
    target: string | null;
    detail: Record<string, unknown> | null;
  }> {
    const rows = this.db.prepare(`
      SELECT id, at, stage, outcome, reason, target, detail
      FROM evolution_decisions
      ORDER BY at DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: number; at: number; stage: string; outcome: string; reason: string | null; target: string | null; detail: string | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      at: r.at,
      stage: r.stage,
      outcome: r.outcome,
      reason: r.reason,
      target: r.target,
      detail: r.detail ? parseDetailJSON(r.detail) : null,
    }));
  }

  /** Record a promoted mutation + its rollback snapshot. Returns the new row id. */
  recordEvolutionVersion(version: {
    target: string;
    kind: string;
    at: number;
    baselineFitness?: number | null;
    snapshot?: string | null;
    detail?: Record<string, unknown> | null;
  }): number {
    const record = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE evolution_versions SET status = 'superseded'
        WHERE target = ? AND status = 'active'
      `).run(version.target);
      const result = this.db.prepare(`
        INSERT INTO evolution_versions (target, kind, at, baseline_fitness, snapshot, status, detail)
        VALUES (?, ?, ?, ?, ?, 'active', ?)
      `).run(
        version.target,
        version.kind,
        version.at,
        version.baselineFitness ?? null,
        version.snapshot ?? null,
        version.detail ? JSON.stringify(version.detail) : null,
      );
      return Number(result.lastInsertRowid);
    });
    return record();
  }

  /** The currently-active promoted version for a target, if any. */
  getActiveEvolutionVersion(target: string): {
    id: number; target: string; kind: string; at: number; baselineFitness: number | null; snapshot: string | null;
  } | null {
    const row = this.db.prepare(`
      SELECT id, target, kind, at, baseline_fitness, snapshot
      FROM evolution_versions
      WHERE target = ? AND status = 'active'
      ORDER BY at DESC LIMIT 1
    `).get(target) as { id: number; target: string; kind: string; at: number; baseline_fitness: number | null; snapshot: string | null } | undefined;
    if (!row) return null;
    return { id: row.id, target: row.target, kind: row.kind, at: row.at, baselineFitness: row.baseline_fitness, snapshot: row.snapshot };
  }

  /** All active promoted versions (for the rollback watchdog). */
  getActiveEvolutionVersions(): Array<{ id: number; target: string; kind: string; at: number; baselineFitness: number | null }> {
    const rows = this.db.prepare(`
      SELECT id, target, kind, at, baseline_fitness
      FROM evolution_versions WHERE status = 'active' ORDER BY at DESC
    `).all() as Array<{ id: number; target: string; kind: string; at: number; baseline_fitness: number | null }>;
    return rows.map(r => ({ id: r.id, target: r.target, kind: r.kind, at: r.at, baselineFitness: r.baseline_fitness }));
  }

  /** Mark a version row as rolled back. */
  markEvolutionVersionRolledBack(id: number): void {
    this.db.prepare(`UPDATE evolution_versions SET status = 'rolled_back' WHERE id = ?`).run(id);
  }

  /** All currently-active prompt fragments (appended to the system prompt). */
  getActivePromptOverrides(): Array<{ fragmentId: string; content: string; version: number }> {
    const rows = this.db.prepare(`
      SELECT fragment_id, content, version FROM prompt_overrides WHERE active = 1 ORDER BY fragment_id
    `).all() as Array<{ fragment_id: string; content: string; version: number }>;
    return rows.map(r => ({ fragmentId: r.fragment_id, content: r.content, version: r.version }));
  }

  /** The active content for one fragment, or null. */
  getActivePromptOverride(fragmentId: string): { content: string; version: number } | null {
    const row = this.db.prepare(`
      SELECT content, version FROM prompt_overrides WHERE fragment_id = ? AND active = 1 ORDER BY version DESC LIMIT 1
    `).get(fragmentId) as { content: string; version: number } | undefined;
    return row ? { content: row.content, version: row.version } : null;
  }

  /** Activate a new version of a fragment, deactivating any prior active one. Returns the new version. */
  upsertPromptOverride(fragmentId: string, content: string, at: number): number {
    const upsert = this.db.transaction(() => {
      const prior = this.db.prepare(`SELECT MAX(version) as v FROM prompt_overrides WHERE fragment_id = ?`).get(fragmentId) as { v: number | null };
      const nextVersion = (prior.v ?? 0) + 1;
      this.db.prepare(`UPDATE prompt_overrides SET active = 0 WHERE fragment_id = ?`).run(fragmentId);
      this.db.prepare(`
        INSERT INTO prompt_overrides (fragment_id, content, active, version, at) VALUES (?, ?, 1, ?, ?)
      `).run(fragmentId, content, nextVersion, at);
      return nextVersion;
    });
    return upsert();
  }

  /** Atomically activate a prompt mutation and its single active rollback ledger. */
  promotePromptEvolution(input: {
    fragmentId: string;
    content: string;
    at: number;
    baselineFitness?: number | null;
    snapshot?: string | null;
    detail?: Record<string, unknown> | null;
  }): { promptVersion: number; evolutionVersionId: number } {
    const promote = this.db.transaction(() => {
      const prior = this.db.prepare(`
        SELECT MAX(version) AS v FROM prompt_overrides WHERE fragment_id = ?
      `).get(input.fragmentId) as { v: number | null };
      const promptVersion = (prior.v ?? 0) + 1;
      this.db.prepare(`UPDATE prompt_overrides SET active = 0 WHERE fragment_id = ?`)
        .run(input.fragmentId);
      this.db.prepare(`
        INSERT INTO prompt_overrides (fragment_id, content, active, version, at)
        VALUES (?, ?, 1, ?, ?)
      `).run(input.fragmentId, input.content, promptVersion, input.at);

      const target = `prompt:${input.fragmentId}`;
      this.db.prepare(`
        UPDATE evolution_versions SET status = 'superseded'
        WHERE target = ? AND status = 'active'
      `).run(target);
      const ledger = this.db.prepare(`
        INSERT INTO evolution_versions (target, kind, at, baseline_fitness, snapshot, status, detail)
        VALUES (?, 'patch_prompt', ?, ?, ?, 'active', ?)
      `).run(
        target,
        input.at,
        input.baselineFitness ?? null,
        input.snapshot ?? null,
        input.detail ? JSON.stringify(input.detail) : null,
      );
      return {
        promptVersion,
        evolutionVersionId: Number(ledger.lastInsertRowid),
      };
    });
    return promote();
  }

  /** Deactivate the active version of a fragment, optionally re-activating a prior content. */
  rollbackPromptOverride(fragmentId: string, restoreContent: string | null, at: number): void {
    const rollback = this.db.transaction(() => {
      const prior = this.db.prepare(`SELECT MAX(version) as v FROM prompt_overrides WHERE fragment_id = ?`).get(fragmentId) as { v: number | null };
      this.db.prepare(`UPDATE prompt_overrides SET active = 0 WHERE fragment_id = ?`).run(fragmentId);
      if (restoreContent !== null) {
        this.db.prepare(`
          INSERT INTO prompt_overrides (fragment_id, content, active, version, at)
          VALUES (?, ?, 1, ?, ?)
        `).run(fragmentId, restoreContent, (prior.v ?? 0) + 1, at);
      }
    });
    rollback();
  }

  /** Roll back prompt content and its active ledger in one SQLite transaction. */
  rollbackPromptEvolutionVersion(
    versionId: number,
    fragmentId: string,
    restoreContent: string | null,
    at: number,
  ): void {
    const rollback = this.db.transaction(() => {
      const target = `prompt:${fragmentId}`;
      const active = this.db.prepare(`
        SELECT id FROM evolution_versions
        WHERE id = ? AND target = ? AND kind = 'patch_prompt' AND status = 'active'
      `).get(versionId, target);
      if (!active) throw new Error(`Prompt evolution version ${versionId} is not active`);

      const prior = this.db.prepare(`SELECT MAX(version) as v FROM prompt_overrides WHERE fragment_id = ?`).get(fragmentId) as { v: number | null };
      this.db.prepare(`UPDATE prompt_overrides SET active = 0 WHERE fragment_id = ?`).run(fragmentId);
      if (restoreContent !== null) {
        this.db.prepare(`
          INSERT INTO prompt_overrides (fragment_id, content, active, version, at)
          VALUES (?, ?, 1, ?, ?)
        `).run(fragmentId, restoreContent, (prior.v ?? 0) + 1, at);
      }
      this.db.prepare(`UPDATE evolution_versions SET status = 'rolled_back' WHERE id = ?`)
        .run(versionId);
    });
    rollback();
  }

  /**
   * Expire old pending nudges (older than maxAgeMs past their trigger time).
   * Unscheduled board work (`trigger_at = 0`), task-kind work, and anything
   * already processing/leased are owned by their explicit worker lifecycle.
   */
  expireOldScheduledItems(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    const cutoff = now - maxAgeMs;
    // Only expire non-recurring items. Recurring items that are overdue
    // will be picked up by the scheduler and rescheduled after firing.
    const stmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'expired', board_status = 'archived', updated_at = ?
      WHERE status = 'pending' AND kind = 'nudge'
        AND trigger_at > 0 AND trigger_at < ?
        AND recurring IS NULL
    `);
    const result = stmt.run(now, cutoff);
    return result.changes;
  }

  /**
   * Find a similar pending agent-source scheduled item near `triggerAt` for the
   * same user. Used by addScheduledItem to suppress duplicate creation by the
   * cognitive layer. Returns the existing item if a match is found, else null.
   *
   * Window is ±2h around the new triggerAt — narrower than
   * hasSimilarPendingScheduledItem so legitimately distinct items at different
   * times of day still go through.
   */
  findSimilarAgentScheduledItem(
    userId: string,
    message: string,
    triggerAt: number,
    sourceItemId: string | null = null,
  ): ScheduledItem | null {
    const WINDOW_MS = 2 * 60 * 60 * 1000;
    const newWords = normalizeForSimilarity(message);
    if (newWords.size === 0) return null;

    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE user_id = ? AND source = 'agent' AND status IN ('pending', 'processing')
        AND trigger_at BETWEEN ? AND ?
        AND ((? IS NULL AND source_item_id IS NULL) OR source_item_id = ?)
    `);
    const rows = stmt.all(
      userId,
      triggerAt - WINDOW_MS,
      triggerAt + WINDOW_MS,
      sourceItemId,
      sourceItemId,
    ) as Record<string, unknown>[];

    for (const row of rows) {
      const existingMessage = (row.message ?? '') as string;
      const existingWords = normalizeForSimilarity(existingMessage);
      if (existingWords.size === 0) continue;

      let overlap = 0;
      for (const word of newWords) {
        if (existingWords.has(word)) overlap++;
      }
      const smaller = Math.min(newWords.size, existingWords.size);
      const similaritySmaller = overlap / smaller;
      const similarityNew = overlap / newWords.size;
      const similarityExisting = overlap / existingWords.size;

      if (similaritySmaller >= DEDUP_SIMILARITY_STRICT
          || similarityNew >= DEDUP_SIMILARITY_LENIENT
          || similarityExisting >= DEDUP_SIMILARITY_LENIENT) {
        return this.rowToScheduledItem(row);
      }
    }
    return null;
  }

  /**
   * Check if a similar pending item already exists (for duplicate detection)
   */
  hasSimilarPendingScheduledItem(userId: string, message: string, withinMs: number = 24 * 60 * 60 * 1000): boolean {
    const now = Date.now();

    // Get all pending items within the time window
    const stmt = this.db.prepare(`
      SELECT message FROM scheduled_items
      WHERE user_id = ? AND status IN ('pending', 'processing')
        AND trigger_at BETWEEN ? AND ?
    `);
    const rows = stmt.all(userId, now - withinMs, now + withinMs * 7) as Array<{ message: string }>;

    if (rows.length === 0) return false;

    const newWords = normalizeForSimilarity(message);
    if (newWords.size === 0) return false;

    for (const row of rows) {
      const existingWords = normalizeForSimilarity(row.message);
      if (existingWords.size === 0) continue;

      let overlap = 0;
      for (const word of newWords) {
        if (existingWords.has(word)) overlap++;
      }

      const smaller = Math.min(newWords.size, existingWords.size);
      const similaritySmaller = overlap / smaller;
      const similarityNew = overlap / newWords.size;
      const similarityExisting = overlap / existingWords.size;

      // Match if: all words in the shorter description overlap,
      // OR either side has 40%+ overlap (lowered from 50% to catch more dupes)
      if (similaritySmaller >= DEDUP_SIMILARITY_STRICT || similarityNew >= DEDUP_SIMILARITY_LENIENT || similarityExisting >= DEDUP_SIMILARITY_LENIENT) {
        return true;
      }
    }

    return false;
  }

  /**
   * Cancel pending/processing scheduled items that reference a deleted memory
   */
  cancelScheduledItemsBySourceMemory(memoryId: string): number {
    const stmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'expired', board_status = 'archived', updated_at = ?
      WHERE source_memory_id = ? AND status IN ('pending', 'processing')
    `);
    const result = stmt.run(Date.now(), memoryId);
    return result.changes;
  }

  /**
   * Null out session_id references on scheduled items that point to non-existent sessions.
   * Prevents "Session not found" errors when scheduled items fire.
   */
  cleanStaleScheduledItemSessions(): number {
    // Find scheduled items with non-null session_id where the session no longer exists
    const staleItems = this.db.prepare(`
      SELECT si.id FROM scheduled_items si
      WHERE si.session_id IS NOT NULL
        AND si.session_id != ''
        AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = si.session_id)
    `).all() as Array<{ id: string }>;

    if (staleItems.length === 0) return 0;

    const updateStmt = this.db.prepare(
      'UPDATE scheduled_items SET session_id = NULL, updated_at = ? WHERE id = ?'
    );
    const now = Date.now();
    for (const item of staleItems) {
      updateStmt.run(now, item.id);
    }
    return staleItems.length;
  }

  /**
   * Remove user profile entries whose value is textually similar to superseded memory content.
   * Prevents stale profile fields (e.g. "focus: meeting with X") from persisting after
   * the source memory is superseded or forgotten.
   */
  cleanStaleProfileEntries(userId: string, content: string): number {
    const contentWords = normalizeForSimilarity(content);
    if (contentWords.size === 0) return 0;

    const entries = this.getProfile(userId);
    let cleaned = 0;

    // Only clean ephemeral fields that are derived from conversations
    const ephemeralFields = new Set(['focus', 'mood']);

    for (const entry of entries) {
      if (!ephemeralFields.has(entry.key)) continue;

      const valueWords = normalizeForSimilarity(entry.value);
      if (valueWords.size === 0) continue;

      let overlap = 0;
      for (const word of contentWords) {
        if (valueWords.has(word)) overlap++;
      }

      const smaller = Math.min(contentWords.size, valueWords.size);
      if (smaller > 0 && (overlap / smaller >= 0.5 || overlap / valueWords.size >= 0.4)) {
        this.deleteProfileValue(userId, entry.key);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Cancel pending scheduled items whose message is textually similar to the given content.
   * Used to clean up orphaned items when a memory is forgotten (sourceMemoryId may be null).
   */
  cancelSimilarScheduledItems(userId: string, content: string): number {
    const stmt = this.db.prepare(`
      SELECT id, message FROM scheduled_items
      WHERE user_id = ? AND status IN ('pending', 'processing')
    `);
    const rows = stmt.all(userId) as Array<{ id: string; message: string }>;

    const contentWords = normalizeForSimilarity(content);
    if (contentWords.size === 0) return 0;

    let cancelled = 0;
    const updateStmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'expired', board_status = 'archived', updated_at = ?
      WHERE id = ?
    `);
    const now = Date.now();

    for (const row of rows) {
      const msgWords = normalizeForSimilarity(row.message);
      if (msgWords.size === 0) continue;

      let overlap = 0;
      for (const word of contentWords) {
        if (msgWords.has(word)) overlap++;
      }

      // Use multiple overlap metrics to catch different phrasing patterns:
      // - overlap/smaller >= 0.5: at least half the words in the shorter text match
      // - overlap/either >= 0.4: at least 40% of either side matches (asymmetric catch)
      const smaller = Math.min(contentWords.size, msgWords.size);
      if (overlap / smaller >= 0.5 || overlap / contentWords.size >= 0.4 || overlap / msgWords.size >= 0.4) {
        updateStmt.run(now, row.id);
        cancelled++;
      }
    }

    return cancelled;
  }

  /**
   * Convert row to ScheduledItem
   */
  private rowToScheduledItem(row: Record<string, unknown>): ScheduledItem {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      sessionId: row.session_id as string | null,
      source: row.source as ScheduledItemSource,
      messageProvenance: row.message_provenance === 'user_literal' ? 'user_literal' : 'generated',
      kind: (row.kind as ScheduledItemKind) ?? 'nudge',
      type: row.type as ScheduledItemType,
      taskConfig: row.task_config ? JSON.parse(row.task_config as string) : null,
      message: row.message as string,
      context: row.context as string | null,
      triggerAt: row.trigger_at as number,
      recurring: row.recurring ? JSON.parse(row.recurring as string) : null,
      status: row.status as ScheduledItemStatus,
      firedAt: row.fired_at as number | null,
      sourceMemoryId: row.source_memory_id as string | null,
      sourceItemId: row.source_item_id as string | null,
      boardStatus: (row.board_status as BoardStatus) ?? null,
      priority: (row.priority as Priority) ?? 'medium',
      labels: row.labels ? JSON.parse(row.labels as string) : null,
      result: row.result ? JSON.parse(row.result as string) : null,
      dependsOn: row.depends_on ? JSON.parse(row.depends_on as string) : null,
      goalId: (row.goal_id as string) ?? null,
      workerId: (row.worker_id as string) ?? null,
      preferredWorkerId: (row.preferred_worker_id as string) ?? null,
      leaseToken: (row.lease_token as string) ?? null,
      leasedAt: (row.leased_at as number) ?? null,
      leaseExpiresAt: (row.lease_expires_at as number) ?? null,
      attemptCount: (row.attempt_count as number) ?? 0,
      maxAttempts: (row.max_attempts as number) ?? 3,
      lastError: (row.last_error as string) ?? null,
      handedOffFrom: (row.handed_off_from as string) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  // ============ Utility Methods ============

  /**
   * Get memory count
   */
  getMemoryCount(userId?: string): number {
    // Exclude migration sentinel rows from count (they're bookkeeping, not real memories)
    const stmt = userId
      ? this.db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND source != '_cleaned_sentinel'")
      : this.db.prepare("SELECT COUNT(*) as count FROM memories WHERE source != '_cleaned_sentinel'");
    const row = (userId ? stmt.get(userId) : stmt.get()) as { count: number };
    return row.count;
  }

  /**
   * Run a raw SQL query (for advanced use cases)
   */
  raw<T>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  /**
   * Begin a transaction
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Close the database
   */
  close(): void {
    this.db.close();
  }

  /**
   * Get database path
   */
  getPath(): string {
    return this.dbPath;
  }

  // ============ Row Conversion Helpers ============

  private rowToMemory(row: Record<string, unknown>): ScallopMemoryEntry {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      content: row.content as string,
      category: row.category as MemoryCategory,
      memoryType: row.memory_type as ScallopMemoryType,
      importance: row.importance as number,
      confidence: row.confidence as number,
      isLatest: (row.is_latest as number) === 1,
      source: (row.source as 'user' | 'assistant') || 'user',
      documentDate: row.document_date as number,
      eventDate: row.event_date as number | null,
      prominence: row.prominence as number,
      lastAccessed: row.last_accessed as number | null,
      accessCount: row.access_count as number,
      sourceChunk: row.source_chunk as string | null,
      embedding: row.embedding ? JSON.parse(row.embedding as string) : null,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
      learnedFrom: (row.learned_from as string) || 'conversation',
      timesConfirmed: (row.times_confirmed as number) || 1,
      contradictionIds: row.contradiction_ids ? JSON.parse(row.contradiction_ids as string) : null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  private rowToRelation(row: Record<string, unknown>): MemoryRelation {
    return {
      id: row.id as string,
      sourceId: row.source_id as string,
      targetId: row.target_id as string,
      relationType: row.relation_type as RelationType,
      confidence: row.confidence as number,
      createdAt: row.created_at as number,
    };
  }

  private rowToProfileEntry(row: Record<string, unknown>): UserProfileEntry {
    return {
      userId: row.user_id as string,
      key: row.key as string,
      value: row.value as string,
      confidence: row.confidence as number,
      updatedAt: row.updated_at as number,
    };
  }

  private rowToDynamicProfile(row: Record<string, unknown>): DynamicProfile {
    return {
      userId: row.user_id as string,
      recentTopics: row.recent_topics ? JSON.parse(row.recent_topics as string) : [],
      currentMood: row.current_mood as string | null,
      activeProjects: row.active_projects ? JSON.parse(row.active_projects as string) : [],
      lastInteraction: row.last_interaction as number,
    };
  }

  private rowToBehavioralPatterns(row: Record<string, unknown>): BehavioralPatterns {
    const rawPrefs: Record<string, unknown> = row.response_preferences
      ? JSON.parse(row.response_preferences as string)
      : {};

    // Extract signal fields from response_preferences JSON
    const messageFrequency = (rawPrefs._sig_messageFrequency as MessageFrequencySignal | undefined) ?? null;
    const sessionEngagement = (rawPrefs._sig_sessionEngagement as SessionEngagementSignal | undefined) ?? null;
    const topicSwitch = (rawPrefs._sig_topicSwitch as TopicSwitchSignal | undefined) ?? null;
    const responseLength = (rawPrefs._sig_responseLength as ResponseLengthSignal | undefined) ?? null;

    // Extract affect fields from response_preferences JSON (plain keys per Phase 24 decision)
    const affectState = (rawPrefs.affectState as AffectEMAState | undefined) ?? null;
    const smoothedAffect = (rawPrefs.smoothedAffect as SmoothedAffect | undefined) ?? null;

    // Build clean responsePreferences without signal fields and affect fields
    const responsePreferences: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawPrefs)) {
      if (!key.startsWith('_sig_') && key !== 'affectState' && key !== 'smoothedAffect') {
        responsePreferences[key] = value;
      }
    }

    return {
      userId: row.user_id as string,
      communicationStyle: row.communication_style as string | null,
      expertiseAreas: row.expertise_areas ? JSON.parse(row.expertise_areas as string) : [],
      responsePreferences,
      activeHours: row.active_hours ? JSON.parse(row.active_hours as string) : [],
      messageFrequency,
      sessionEngagement,
      topicSwitch,
      responseLength,
      affectState,
      smoothedAffect,
      updatedAt: row.updated_at as number,
    };
  }

  private rowToSession(row: Record<string, unknown>): SessionRow {
    let metadata: Record<string, unknown> | null = null;
    if (typeof row.metadata === 'string') {
      try {
        const parsed = JSON.parse(row.metadata) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {
        // Preserve the row and treat malformed legacy metadata as unknown.
      }
    }
    return {
      id: row.id as string,
      metadata,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      archivedAt: row.archived_at == null ? null : row.archived_at as number,
      archiveReason: row.archive_reason == null ? null : row.archive_reason as string,
      transcriptDeletedAt: row.transcript_deleted_at == null ? null : row.transcript_deleted_at as number,
    };
  }

  private rowToSessionMessage(row: Record<string, unknown>): SessionMessageRow {
    const metadata = typeof row.session_metadata === 'string'
      ? parseDetailJSON(row.session_metadata)
      : null;
    const messageKind = isPersistedSessionMessageKind(row.message_kind)
      ? row.message_kind
      : inferSessionMessageKind(String(row.role), row.content, metadata);
    return {
      id: row.id as number,
      sessionId: row.session_id as string,
      role: row.role as string,
      content: row.content as string,
      messageKind,
      createdAt: row.created_at as number,
    };
  }

  private rowToBotConfig(row: Record<string, unknown>): BotConfigRow {
    return {
      userId: row.user_id as string,
      botName: row.bot_name as string,
      personalityId: row.personality_id as string,
      customPersonality: row.custom_personality as string | null,
      modelId: row.model_id as string,
      timezone: (row.timezone as string) || 'UTC',
      onboardingComplete: (row.onboarding_complete as number) === 1,
      onboardingStep: row.onboarding_step as string | null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private rowToCostUsage(row: Record<string, unknown>): CostUsageRow {
    return {
      id: row.id as number,
      model: row.model as string,
      provider: row.provider as string,
      sessionId: row.session_id as string,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      cost: row.cost as number,
      timestamp: row.timestamp as number,
    };
  }

  // ============ Sub-Agent Run Methods ============

  insertSubAgentRun(run: SubAgentRunRow): void {
    this.db.prepare(`
      INSERT INTO subagent_runs (
        id, parent_session_id, child_session_id, task, label, status,
        allowed_skills, model_tier, timeout_ms, input_tokens, output_tokens,
        created_at, started_at, completed_at, task_name, parent_run_id,
        batch_id, batch_index, role, spawn_depth, context_mode, workspace_mode,
        workspace_path, idle_timeout_ms, hard_timeout_ms, last_progress_at,
        result_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id, run.parentSessionId, run.childSessionId, run.task, run.label, run.status,
      run.allowedSkills, run.modelTier, run.timeoutMs, run.inputTokens, run.outputTokens,
      run.createdAt, run.startedAt ?? null, run.completedAt ?? null,
      run.taskName ?? null, run.parentRunId ?? null, run.batchId ?? null, run.batchIndex ?? null,
      run.role ?? 'leaf', run.spawnDepth ?? 0, run.contextMode ?? 'brief',
      run.workspaceMode ?? 'shared', run.workspacePath ?? null, run.idleTimeoutMs ?? 300_000,
      run.hardTimeoutMs ?? run.timeoutMs, run.lastProgressAt ?? null, run.resultJson ?? null,
      run.updatedAt ?? run.createdAt
    );
  }

  updateSubAgentRun(id: string, updates: Partial<SubAgentRunRow>): void {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) { setClauses.push('status = ?'); values.push(updates.status); }
    if (updates.resultResponse !== undefined) { setClauses.push('result_response = ?'); values.push(updates.resultResponse); }
    if (updates.resultIterations !== undefined) { setClauses.push('result_iterations = ?'); values.push(updates.resultIterations); }
    if (updates.resultTaskComplete !== undefined) { setClauses.push('result_task_complete = ?'); values.push(updates.resultTaskComplete ? 1 : 0); }
    if (updates.error !== undefined) { setClauses.push('error = ?'); values.push(updates.error); }
    if (updates.inputTokens !== undefined) { setClauses.push('input_tokens = ?'); values.push(updates.inputTokens); }
    if (updates.outputTokens !== undefined) { setClauses.push('output_tokens = ?'); values.push(updates.outputTokens); }
    if (updates.startedAt !== undefined) { setClauses.push('started_at = ?'); values.push(updates.startedAt); }
    if (updates.completedAt !== undefined) { setClauses.push('completed_at = ?'); values.push(updates.completedAt); }
    if (updates.lastProgressAt !== undefined) { setClauses.push('last_progress_at = ?'); values.push(updates.lastProgressAt); }
    if (updates.workspacePath !== undefined) { setClauses.push('workspace_path = ?'); values.push(updates.workspacePath); }
    if (updates.resultJson !== undefined) { setClauses.push('result_json = ?'); values.push(updates.resultJson); }
    setClauses.push('updated_at = ?'); values.push(Date.now());

    if (setClauses.length === 0) return;

    values.push(id);
    this.db.prepare(`UPDATE subagent_runs SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
  }

  getSubAgentRunsByParent(parentSessionId: string): SubAgentRunRow[] {
    const rows = this.db.prepare(
      'SELECT * FROM subagent_runs WHERE parent_session_id = ? ORDER BY created_at DESC'
    ).all(parentSessionId) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToSubAgentRun(r));
  }

  getActiveSubAgentRuns(): SubAgentRunRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM subagent_runs WHERE status IN ('pending', 'running')"
    ).all() as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToSubAgentRun(r));
  }

  getRecentSubAgentRuns(limit = 100): SubAgentRunRow[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.db.prepare(
      'SELECT * FROM subagent_runs ORDER BY created_at DESC LIMIT ?'
    ).all(safeLimit) as Array<Record<string, unknown>>;
    return rows.map(row => this.rowToSubAgentRun(row));
  }

  enqueueSubAgentDelivery(input: {
    runId: string;
    parentSessionId: string;
    userId?: string | null;
    payloadJson: string;
  }): boolean {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO subagent_delivery_outbox (
        run_id, parent_session_id, user_id, payload_json, status, attempts,
        available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(input.runId, input.parentSessionId, input.userId ?? null, input.payloadJson, now, now, now);
    return result.changes === 1;
  }

  claimSubAgentDeliveries(limit = 10, leaseMs = 30_000): SubAgentDeliveryRow[] {
    const claim = this.db.transaction(() => {
      const now = Date.now();
      const rows = this.db.prepare(`
        SELECT * FROM subagent_delivery_outbox
        WHERE available_at <= ?
          AND (status IN ('pending', 'failed') OR (status = 'leased' AND lease_expires_at < ?))
        ORDER BY created_at ASC LIMIT ?
      `).all(now, now, Math.max(1, Math.min(100, limit))) as Array<Record<string, unknown>>;
      const claimed: SubAgentDeliveryRow[] = [];
      for (const row of rows) {
        const token = randomUUID();
        const updated = this.db.prepare(`
          UPDATE subagent_delivery_outbox
          SET status = 'leased', lease_token = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
          WHERE run_id = ?
            AND (status IN ('pending', 'failed') OR (status = 'leased' AND lease_expires_at < ?))
        `).run(token, now + leaseMs, now, row.run_id, now);
        if (updated.changes === 1) {
          claimed.push(this.rowToSubAgentDelivery({ ...row, status: 'leased', lease_token: token,
            lease_expires_at: now + leaseMs, attempts: Number(row.attempts) + 1, updated_at: now }));
        }
      }
      return claimed;
    });
    return claim();
  }

  completeSubAgentDelivery(runId: string, leaseToken: string): boolean {
    const now = Date.now();
    return this.db.prepare(`
      UPDATE subagent_delivery_outbox
      SET status = 'delivered', delivered_at = ?, updated_at = ?, payload_json = '{}',
          last_error = NULL, lease_token = NULL, lease_expires_at = NULL
      WHERE run_id = ? AND status = 'leased' AND lease_token = ?
    `).run(now, now, runId, leaseToken).changes === 1;
  }

  failSubAgentDelivery(runId: string, leaseToken: string, error: string): boolean {
    const now = Date.now();
    const row = this.db.prepare('SELECT attempts FROM subagent_delivery_outbox WHERE run_id = ?').get(runId) as { attempts: number } | undefined;
    const delay = Math.min(15 * 60_000, 1_000 * 2 ** Math.min(row?.attempts ?? 1, 9));
    return this.db.prepare(`
      UPDATE subagent_delivery_outbox
      SET status = 'failed', available_at = ?, last_error = ?, updated_at = ?, lease_token = NULL, lease_expires_at = NULL
      WHERE run_id = ? AND status = 'leased' AND lease_token = ?
    `).run(now + delay, redactSensitiveText(error).slice(0, 500), now, runId, leaseToken).changes === 1;
  }

  deleteOldSubAgentRuns(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db.prepare(
      `DELETE FROM subagent_runs
       WHERE status NOT IN ('pending', 'running')
         AND COALESCE(completed_at, created_at) < ?
         AND NOT EXISTS (
           SELECT 1 FROM subagent_delivery_outbox delivery
           WHERE delivery.run_id = subagent_runs.id AND delivery.status != 'delivered'
         )`
    ).run(cutoff);
    return result.changes;
  }

  /**
   * Remove bulky/private run payloads but keep the compact execution ledger
   * (status, timings, model, token counts, iterations and completion signal).
   */
  compactOldSubAgentRuns(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db.prepare(`
      UPDATE subagent_runs
      SET task = '[compacted]', label = 'sub-agent', allowed_skills = NULL,
          result_response = NULL, result_json = NULL,
          error = CASE WHEN error IS NULL THEN NULL ELSE '[redacted]' END
      WHERE status NOT IN ('pending', 'running')
        AND COALESCE(completed_at, created_at) < ?
        AND (task != '[compacted]' OR allowed_skills IS NOT NULL
          OR result_response IS NOT NULL OR (error IS NOT NULL AND error != '[redacted]'))
    `).run(cutoff);
    return result.changes;
  }

  getSubAgentChildSessionIds(maxAgeMs?: number): string[] {
    const sql = maxAgeMs
      ? "SELECT child_session_id FROM subagent_runs WHERE status NOT IN ('pending', 'running') AND COALESCE(completed_at, created_at) < ?"
      : 'SELECT child_session_id FROM subagent_runs';
    const params = maxAgeMs ? [Date.now() - maxAgeMs] : [];
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(r => r.child_session_id as string);
  }

  private rowToSubAgentRun(row: Record<string, unknown>): SubAgentRunRow {
    return {
      id: row.id as string,
      parentSessionId: row.parent_session_id as string,
      childSessionId: row.child_session_id as string,
      task: row.task as string,
      label: row.label as string,
      status: row.status as string,
      allowedSkills: row.allowed_skills as string | null,
      modelTier: row.model_tier as string,
      timeoutMs: row.timeout_ms as number,
      resultResponse: row.result_response as string | null,
      resultIterations: row.result_iterations as number | null,
      resultTaskComplete: row.result_task_complete != null ? !!(row.result_task_complete as number) : null,
      error: row.error as string | null,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      createdAt: row.created_at as number,
      startedAt: row.started_at as number | null,
      completedAt: row.completed_at as number | null,
      taskName: row.task_name as string | null,
      parentRunId: row.parent_run_id as string | null,
      batchId: row.batch_id as string | null,
      batchIndex: row.batch_index as number | null,
      role: (row.role as string) || 'leaf',
      spawnDepth: Number(row.spawn_depth ?? 0),
      contextMode: (row.context_mode as string) || 'brief',
      workspaceMode: (row.workspace_mode as string) || 'shared',
      workspacePath: row.workspace_path as string | null,
      idleTimeoutMs: Number(row.idle_timeout_ms ?? 300_000),
      hardTimeoutMs: Number(row.hard_timeout_ms ?? row.timeout_ms ?? 0),
      lastProgressAt: row.last_progress_at as number | null,
      resultJson: row.result_json as string | null,
      updatedAt: Number(row.updated_at ?? row.completed_at ?? row.started_at ?? row.created_at),
    };
  }

  private rowToSubAgentDelivery(row: Record<string, unknown>): SubAgentDeliveryRow {
    return {
      runId: row.run_id as string,
      parentSessionId: row.parent_session_id as string,
      userId: row.user_id as string | null,
      payloadJson: row.payload_json as string,
      status: row.status as SubAgentDeliveryRow['status'],
      attempts: Number(row.attempts),
      availableAt: Number(row.available_at),
      leaseToken: row.lease_token as string | null,
      leaseExpiresAt: row.lease_expires_at as number | null,
      lastError: row.last_error as string | null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      deliveredAt: row.delivered_at as number | null,
    };
  }

  // ============ Auth ============

  hasAuthUser(): boolean {
    const row = this.db.prepare('SELECT 1 FROM auth_user WHERE id = 1').get();
    return !!row;
  }

  createAuthUser(email: string, passwordHash: string): void {
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO auth_user (id, email, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)'
    ).run(email, passwordHash, now, now);
  }

  getAuthUser(): { email: string; passwordHash: string } | null {
    const row = this.db.prepare('SELECT email, password_hash FROM auth_user WHERE id = 1').get() as
      | { email: string; password_hash: string }
      | undefined;
    if (!row) return null;
    return { email: row.email, passwordHash: row.password_hash };
  }

  createAuthSession(token: string, ttlMs: number): void {
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO auth_sessions (token, created_at, expires_at, last_active) VALUES (?, ?, ?, ?)'
    ).run(token, now, now + ttlMs, now);
  }

  validateAuthSession(token: string): boolean {
    const now = Date.now();
    const row = this.db.prepare('SELECT expires_at FROM auth_sessions WHERE token = ?').get(token) as
      | { expires_at: number }
      | undefined;
    if (!row || row.expires_at <= now) return false;
    this.db.prepare('UPDATE auth_sessions SET last_active = ? WHERE token = ?').run(now, token);
    return true;
  }

  deleteAuthSession(token: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
  }

  purgeExpiredSessions(): number {
    const result = this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());
    return result.changes;
  }

  // ============ Runtime Key Vault Operations ============

  setRuntimeKey(key: string, value: string): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO runtime_keys (key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now, now);
  }

  getRuntimeKey(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM runtime_keys WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  deleteRuntimeKey(key: string): boolean {
    const result = this.db.prepare('DELETE FROM runtime_keys WHERE key = ?').run(key);
    return result.changes > 0;
  }

  getAllRuntimeKeys(): Array<{ key: string; value: string }> {
    const rows = this.db.prepare('SELECT key, value FROM runtime_keys ORDER BY key').all() as
      Array<{ key: string; value: string }>;
    return rows;
  }

}

/**
 * Create a ScallopDatabase instance
 */
export function createDatabase(dbPath: string): ScallopDatabase {
  return new ScallopDatabase(dbPath);
}
