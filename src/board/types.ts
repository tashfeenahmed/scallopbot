/**
 * Board (Kanban) Types
 *
 * Re-exports core types from db.ts and defines board-specific view types.
 */

import type {
  BoardStatus,
  Priority,
  BoardItemResult,
  ScheduledItem,
  ScheduledItemKind,
  ScheduledItemType,
  RecurringSchedule,
} from '../memory/db.js';

// Re-export for convenience
export type { BoardStatus, Priority, BoardItemResult };

/**
 * A board item enriched with computed board status (for legacy items)
 */
export interface BoardItem {
  id: string;
  title: string;
  kind: ScheduledItemKind;
  type: ScheduledItemType;
  boardStatus: BoardStatus;
  priority: Priority;
  labels: string[] | null;
  triggerAt: number;
  recurring: RecurringSchedule | null;
  goalId: string | null;
  goalTitle?: string;          // enriched from memories table
  dependsOn: string[] | null;
  result: BoardItemResult | null;
  source: 'user' | 'agent';
  createdAt: number;
  updatedAt: number;
}

/**
 * Detailed view of a board item (for `detail` action)
 */
export interface BoardItemDetail extends BoardItem {
  context: string | null;
  sourceMemoryId: string | null;
  sessionId: string | null;
  /** Raw scheduled item for internal use */
  _raw: ScheduledItem;
}

/**
 * Board view grouped by columns
 */
export interface BoardView {
  columns: Record<BoardStatus, BoardItem[]>;
  counts: Record<BoardStatus, number>;
  /** Stats for the summary line */
  stats: {
    doneThisWeek: number;
    totalActive: number;
    urgentCount: number;
  };
}

/**
 * Filters for board view
 */
export interface BoardFilter {
  column?: BoardStatus;
  priority?: Priority;
  label?: string;
}

/**
 * Input for creating a new board item
 */
export interface CreateBoardItemInput {
  title: string;
  kind?: ScheduledItemKind;
  triggerTime?: string;           // natural language time
  triggerAt?: number;             // epoch ms (if already parsed)
  recurring?: RecurringSchedule;
  priority?: Priority;
  labels?: string[];
  goalId?: string;
  taskConfig?: { goal: string; tools?: string[] };
  source?: 'user' | 'agent';
  context?: string;
  boardStatus?: BoardStatus;     // override default column
}

/**
 * Compute board status from legacy scheduled item fields
 * When board_status IS NULL, derive from existing fields for backward compatibility
 */
export function computeBoardStatus(item: ScheduledItem): BoardStatus {
  if (item.boardStatus) return item.boardStatus;

  switch (item.status) {
    case 'pending':
      return item.triggerAt > 0 ? 'scheduled' : 'inbox';
    case 'processing':
      return 'in_progress';
    case 'fired':
    case 'acted':
      return 'done';
    case 'dismissed':
    case 'expired':
      return 'archived';
    default:
      return 'inbox';
  }
}

/**
 * Convert a ScheduledItem to a BoardItem with computed status
 */
export function toBoardItem(item: ScheduledItem, goalTitle?: string): BoardItem {
  return {
    id: item.id,
    title: item.message,
    kind: item.kind,
    type: item.type,
    boardStatus: computeBoardStatus(item),
    priority: item.priority ?? 'medium',
    labels: item.labels,
    triggerAt: item.triggerAt,
    recurring: item.recurring,
    goalId: item.goalId,
    goalTitle,
    dependsOn: item.dependsOn,
    result: item.result,
    source: item.source,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/**
 * Convert a ScheduledItem to a BoardItemDetail
 */
export function toBoardItemDetail(item: ScheduledItem, goalTitle?: string): BoardItemDetail {
  return {
    ...toBoardItem(item, goalTitle),
    context: item.context,
    sourceMemoryId: item.sourceMemoryId,
    sessionId: item.sessionId,
    _raw: item,
  };
}
