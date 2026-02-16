/**
 * BoardService — Core logic layer for the kanban board
 *
 * Provides all board operations (view, create, move, update, done, archive, detail, snooze).
 * Called by the board skill script, scheduler, and cognitive layer.
 */

import type { ScallopDatabase, BoardStatus, Priority, BoardItemResult, ScheduledItemKind } from '../memory/db.js';
import type {
  BoardView,
  BoardItem,
  BoardItemDetail,
  BoardFilter,
  CreateBoardItemInput,
} from './types.js';
import { computeBoardStatus, toBoardItem, toBoardItemDetail } from './types.js';
import type { Logger } from 'pino';

const BOARD_COLUMNS: BoardStatus[] = [
  'inbox', 'backlog', 'scheduled', 'in_progress', 'waiting', 'done', 'archived',
];

const ACTIVE_COLUMNS: BoardStatus[] = [
  'inbox', 'backlog', 'scheduled', 'in_progress', 'waiting',
];

export class BoardService {
  constructor(
    private db: ScallopDatabase,
    private logger?: Logger,
  ) {}

  // ─── Queries ────────────────────────────────────────────────────────

  /**
   * Get the full board view, grouped by columns with optional filters
   */
  getBoard(userId: string, filter?: BoardFilter): BoardView {
    const allItems = this.db.getScheduledItemsForBoard(userId);

    // Enrich with goal titles
    const goalIds = new Set(allItems.filter(i => i.goalId).map(i => i.goalId!));
    const goalTitles = new Map<string, string>();
    for (const gid of goalIds) {
      const mem = this.db.getMemory(gid);
      if (mem) goalTitles.set(gid, mem.content);
    }

    // Convert to board items with computed status
    let boardItems = allItems.map(item =>
      toBoardItem(item, item.goalId ? goalTitles.get(item.goalId) : undefined)
    );

    // Apply filters
    if (filter?.column) {
      boardItems = boardItems.filter(i => i.boardStatus === filter.column);
    }
    if (filter?.priority) {
      boardItems = boardItems.filter(i => i.priority === filter.priority);
    }
    if (filter?.label) {
      boardItems = boardItems.filter(i => i.labels?.includes(filter.label!) ?? false);
    }

    // Group by column
    const columns = {} as Record<BoardStatus, BoardItem[]>;
    for (const col of BOARD_COLUMNS) {
      columns[col] = [];
    }
    for (const item of boardItems) {
      columns[item.boardStatus].push(item);
    }

    // Counts
    const counts = {} as Record<BoardStatus, number>;
    for (const col of BOARD_COLUMNS) {
      counts[col] = columns[col].length;
    }

    // Stats
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const doneThisWeek = columns.done.filter(i => i.updatedAt > weekAgo).length;
    const totalActive = ACTIVE_COLUMNS.reduce((sum, col) => sum + counts[col], 0);
    const urgentCount = boardItems.filter(i => i.priority === 'urgent' && ACTIVE_COLUMNS.includes(i.boardStatus)).length;

    return {
      columns,
      counts,
      stats: { doneThisWeek, totalActive, urgentCount },
    };
  }

  /**
   * Get a single item with full detail
   */
  getItem(itemId: string): BoardItemDetail | null {
    const item = this.db.getScheduledItem(itemId);
    if (!item) return null;

    let goalTitle: string | undefined;
    if (item.goalId) {
      const mem = this.db.getMemory(item.goalId);
      if (mem) goalTitle = mem.content;
    }

    return toBoardItemDetail(item, goalTitle);
  }

  // ─── Mutations ──────────────────────────────────────────────────────

  /**
   * Create a new board item
   */
  createItem(userId: string, input: CreateBoardItemInput): BoardItem {
    const triggerAt = input.triggerAt ?? (input.triggerTime ? 0 : 0); // caller should parse time
    const kind: ScheduledItemKind = input.kind ?? 'nudge';

    // Determine initial board status
    let boardStatus: BoardStatus;
    if (input.boardStatus) {
      boardStatus = input.boardStatus;
    } else if (triggerAt > 0) {
      boardStatus = 'scheduled';
    } else if (input.source === 'agent') {
      boardStatus = 'inbox';
    } else {
      boardStatus = 'backlog';
    }

    const item = this.db.addScheduledItem({
      userId,
      sessionId: null,
      source: input.source ?? 'user',
      kind,
      type: kind === 'task' ? 'event_prep' : 'reminder',
      message: input.title,
      context: input.context ?? null,
      triggerAt,
      recurring: input.recurring ?? null,
      sourceMemoryId: null,
      boardStatus,
      priority: input.priority ?? 'medium',
      labels: input.labels ?? null,
      dependsOn: null,
      goalId: input.goalId ?? null,
      taskConfig: input.taskConfig ?? null,
    });

    this.logger?.debug({ itemId: item.id, boardStatus, kind }, 'Board item created');

    let goalTitle: string | undefined;
    if (item.goalId) {
      const mem = this.db.getMemory(item.goalId);
      if (mem) goalTitle = mem.content;
    }

    return toBoardItem(item, goalTitle);
  }

  /**
   * Move an item to a different column
   */
  moveItem(itemId: string, targetStatus: BoardStatus): BoardItem | null {
    const item = this.db.getScheduledItem(itemId);
    if (!item) return null;

    // Map board status to underlying status where needed
    let underlyingStatus = item.status;
    if (targetStatus === 'done') underlyingStatus = 'fired';
    else if (targetStatus === 'archived') underlyingStatus = 'dismissed';
    else if (targetStatus === 'in_progress') underlyingStatus = 'processing';
    else if (['inbox', 'backlog', 'scheduled', 'waiting'].includes(targetStatus)) underlyingStatus = 'pending';

    this.db.updateScheduledItemBoard(itemId, {
      boardStatus: targetStatus,
      status: underlyingStatus,
    });

    this.logger?.debug({ itemId, from: computeBoardStatus(item), to: targetStatus }, 'Board item moved');

    const updated = this.db.getScheduledItem(itemId);
    return updated ? toBoardItem(updated) : null;
  }

  /**
   * Update item fields
   */
  updateItem(itemId: string, updates: {
    title?: string;
    priority?: Priority;
    labels?: string[] | null;
    triggerAt?: number;
    kind?: ScheduledItemKind;
    goalId?: string | null;
  }): BoardItem | null {
    const item = this.db.getScheduledItem(itemId);
    if (!item) return null;

    this.db.updateScheduledItemBoard(itemId, {
      message: updates.title,
      priority: updates.priority,
      labels: updates.labels,
      triggerAt: updates.triggerAt,
      kind: updates.kind,
      goalId: updates.goalId,
    });

    const updated = this.db.getScheduledItem(itemId);
    return updated ? toBoardItem(updated) : null;
  }

  /**
   * Mark an item as done, optionally storing a result.
   * If the item has a goalId, auto-complete the linked goal task.
   */
  markDone(itemId: string, resultText?: string): BoardItem | null {
    const item = this.db.getScheduledItem(itemId);
    if (!item) return null;

    this.db.updateScheduledItemBoard(itemId, {
      boardStatus: 'done',
      status: 'fired',
    });

    if (resultText) {
      this.db.updateScheduledItemResult(itemId, {
        response: resultText,
        completedAt: Date.now(),
      });
    }

    // Goal bridge: if this board item is linked to a goal, mark the goal task complete
    if (item.goalId) {
      try {
        const goalMem = this.db.getMemory(item.goalId);
        if (goalMem) {
          const metadata = goalMem.metadata as Record<string, unknown> | null;
          if (metadata?.goalType && metadata.status !== 'completed') {
            const now = Date.now();
            const newMetadata = { ...metadata, status: 'completed', completedAt: now };
            this.db.updateMemory(item.goalId, { metadata: newMetadata });

            // Update parent progress (milestone → goal chain)
            const parentId = metadata.parentId as string | undefined;
            if (parentId) {
              this.updateGoalProgress(parentId);
              const parent = this.db.getMemory(parentId);
              const parentMeta = parent?.metadata as Record<string, unknown> | null;
              if (parentMeta?.parentId) {
                this.updateGoalProgress(parentMeta.parentId as string);
              }
            }
            this.logger?.info({ itemId, goalId: item.goalId }, 'Board done → goal task completed');
          }
        }
      } catch (err) {
        this.logger?.warn({ itemId, goalId: item.goalId, error: (err as Error).message }, 'Goal bridge completion failed');
      }
    }

    this.logger?.debug({ itemId }, 'Board item marked done');

    const updated = this.db.getScheduledItem(itemId);
    return updated ? toBoardItem(updated) : null;
  }

  /**
   * Recalculate and store progress for a goal/milestone.
   * Used by the goal bridge when completing board items.
   */
  private updateGoalProgress(goalId: string): void {
    const goal = this.db.getMemory(goalId);
    if (!goal) return;

    const metadata = goal.metadata as Record<string, unknown> | null;
    if (!metadata?.goalType) return;

    // Get children via EXTENDS relations
    const relations = this.db.getIncomingRelations(goalId, 'EXTENDS');
    if (relations.length === 0) return;

    let completed = 0;
    for (const rel of relations) {
      const child = this.db.getMemory(rel.sourceId);
      const childMeta = child?.metadata as Record<string, unknown> | null;
      if (childMeta?.status === 'completed') completed++;
    }

    const progress = Math.round((completed / relations.length) * 100);
    this.db.updateMemory(goalId, { metadata: { ...metadata, progress } });
  }

  /**
   * Archive an item
   */
  archive(itemId: string): BoardItem | null {
    return this.moveItem(itemId, 'archived');
  }

  /**
   * Snooze an item — reschedule its trigger time
   */
  snooze(itemId: string, newTriggerAt: number): BoardItem | null {
    const item = this.db.getScheduledItem(itemId);
    if (!item) return null;

    this.db.updateScheduledItemBoard(itemId, {
      boardStatus: 'scheduled',
      status: 'pending',
      triggerAt: newTriggerAt,
    });

    this.logger?.debug({ itemId, newTriggerAt }, 'Board item snoozed');

    const updated = this.db.getScheduledItem(itemId);
    return updated ? toBoardItem(updated) : null;
  }

  /**
   * Store a result on a board item (called by scheduler after sub-agent completes)
   */
  storeResult(itemId: string, result: BoardItemResult): void {
    this.db.updateScheduledItemResult(itemId, result);
    this.logger?.debug({ itemId }, 'Board item result stored');
  }

  /**
   * Auto-archive done items older than 7 days
   */
  autoArchive(userId: string): number {
    return this.db.autoArchiveDoneItems(userId);
  }

  // ─── System Prompt Context ──────────────────────────────────────────

  /**
   * Generate compact board context for the system prompt.
   * Full board shown for task/board keywords, minimal summary otherwise.
   */
  getBoardContext(userId: string, userMessage?: string): string {
    const board = this.getBoard(userId);

    const isFullView = userMessage && /\b(board|kanban|task|todo|remind|reminder|schedule|plate|what'?s next|priorities|progress|status|overview|how am i doing|work items)\b/i.test(userMessage);

    if (isFullView) {
      return this.formatFullBoardContext(board);
    }

    // Minimal summary
    const { totalActive, urgentCount } = board.stats;
    if (totalActive === 0) return '';

    const parts: string[] = [];
    if (urgentCount > 0) parts.push(`${urgentCount} urgent`);
    if (board.counts.in_progress > 0) parts.push(`${board.counts.in_progress} in progress`);
    if (board.counts.scheduled > 0) parts.push(`${board.counts.scheduled} scheduled`);
    if (board.counts.inbox > 0) parts.push(`${board.counts.inbox} in inbox`);

    return `\n\n## TASK BOARD\n[You have ${totalActive} active items: ${parts.join(', ')}. Use the board skill to view details.]`;
  }

  private formatFullBoardContext(board: BoardView): string {
    let ctx = '\n\n## TASK BOARD';

    for (const col of ACTIVE_COLUMNS) {
      const items = board.columns[col];
      if (items.length === 0) continue;

      const label = col.replace('_', ' ').toUpperCase();
      ctx += `\n### ${label} (${items.length})`;

      for (const item of items.slice(0, 10)) {
        const id = item.id.substring(0, 6);
        const pri = item.priority === 'urgent' ? ' !!!' : item.priority === 'high' ? ' !!' : '';
        const kind = item.kind === 'task' ? ' [task]' : '';
        const goal = item.goalTitle ? ` → ${item.goalTitle.substring(0, 30)}` : '';
        const time = item.triggerAt > 0 ? ` · ${new Date(item.triggerAt).toLocaleDateString()}` : '';
        ctx += `\n- [${id}] ${item.title}${pri}${kind}${goal}${time}`;
      }
      if (items.length > 10) {
        ctx += `\n  ...and ${items.length - 10} more`;
      }
    }

    ctx += `\n${board.counts.backlog} in backlog · ${board.stats.doneThisWeek} done this week`;
    return ctx;
  }

  // ─── Display Formatting ─────────────────────────────────────────────

  /**
   * Format the board for user-facing display (used by the board skill)
   */
  formatBoardDisplay(board: BoardView): string {
    let output = '📋 YOUR BOARD\n';

    // Urgent items first (across all active columns)
    const urgentItems = ACTIVE_COLUMNS
      .flatMap(col => board.columns[col])
      .filter(i => i.priority === 'urgent');

    if (urgentItems.length > 0) {
      output += '\n🔴 URGENT\n';
      for (const item of urgentItems) {
        output += this.formatItemLine(item);
      }
    }

    // Active columns (skip urgent items already shown)
    for (const col of ACTIVE_COLUMNS) {
      const items = board.columns[col].filter(i => i.priority !== 'urgent');
      if (items.length === 0) continue;

      const icon = this.columnIcon(col);
      const label = col.replace('_', ' ').toUpperCase();
      output += `\n${icon} ${label} (${board.columns[col].length})\n`;

      for (const item of items) {
        output += this.formatItemLine(item);
      }
    }

    // Summary line
    const parts: string[] = [];
    if (board.counts.backlog > 0) parts.push(`${board.counts.backlog} in backlog`);
    if (board.stats.doneThisWeek > 0) parts.push(`${board.stats.doneThisWeek} done this week`);
    if (parts.length > 0) {
      output += `\n${parts.join(' · ')}`;
    }

    return output;
  }

  /**
   * Format a single item detail for display
   */
  formatItemDetail(detail: BoardItemDetail): string {
    const status = detail.boardStatus.replace('_', ' ').toUpperCase();
    let output = `📌 ${detail.title}\n`;
    output += `Status: ${status} · Priority: ${detail.priority} · Kind: ${detail.kind}\n`;
    output += `ID: ${detail.id}\n`;

    if (detail.triggerAt > 0) {
      output += `Scheduled: ${new Date(detail.triggerAt).toLocaleString()}\n`;
    }
    if (detail.recurring) {
      output += `Recurring: ${detail.recurring.type} at ${String(detail.recurring.hour).padStart(2, '0')}:${String(detail.recurring.minute).padStart(2, '0')}\n`;
    }
    if (detail.goalTitle) {
      output += `Goal: ${detail.goalTitle}\n`;
    }
    if (detail.labels && detail.labels.length > 0) {
      output += `Labels: ${detail.labels.join(', ')}\n`;
    }
    if (detail.dependsOn && detail.dependsOn.length > 0) {
      output += `Depends on: ${detail.dependsOn.join(', ')}\n`;
    }
    if (detail.context) {
      output += `Context: ${detail.context}\n`;
    }
    if (detail.result) {
      output += `\n--- Result ---\n${detail.result.response}\n`;
      output += `Completed: ${new Date(detail.result.completedAt).toLocaleString()}\n`;
      if (detail.result.iterationsUsed) {
        output += `Iterations: ${detail.result.iterationsUsed}\n`;
      }
    }
    output += `\nCreated: ${new Date(detail.createdAt).toLocaleString()}`;
    output += ` · Source: ${detail.source}`;

    return output;
  }

  private formatItemLine(item: BoardItem): string {
    const id = item.id.substring(0, 6);
    const kindIcon = item.kind === 'task' ? '⚡' : '💬';
    const source = item.source === 'agent' ? '🤖 ' : '';
    const goal = item.goalTitle ? ` · 🎯 ${item.goalTitle.substring(0, 25)}` : '';
    const recurring = item.recurring ? ' 🔁' : '';

    let timeStr = '';
    if (item.triggerAt > 0) {
      const d = new Date(item.triggerAt);
      const now = new Date();
      const diffMs = item.triggerAt - now.getTime();

      if (diffMs < 0) {
        timeStr = ' · overdue';
      } else if (diffMs < 24 * 60 * 60 * 1000) {
        timeStr = ` · today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      } else if (diffMs < 48 * 60 * 60 * 1000) {
        timeStr = ` · tomorrow ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      } else {
        timeStr = ` · ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
      }
    }

    let status = '';
    if (item.boardStatus === 'in_progress') status = ' · running...';
    if (item.boardStatus === 'waiting') status = ' · blocked';

    return `  [${id}] ${source}${item.title} ${kindIcon}${item.kind}${timeStr}${goal}${recurring}${status}\n`;
  }

  private columnIcon(col: BoardStatus): string {
    switch (col) {
      case 'inbox': return '📥';
      case 'backlog': return '📋';
      case 'scheduled': return '📅';
      case 'in_progress': return '▸';
      case 'waiting': return '⏸';
      case 'done': return '✅';
      case 'archived': return '📦';
      default: return '▸';
    }
  }
}
