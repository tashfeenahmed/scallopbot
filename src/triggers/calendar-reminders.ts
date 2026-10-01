/**
 * Calendar heads-up: a short message on the owner's primary channel
 * CALENDAR_REMINDER_MINUTES before each timed event. Off unless that is set.
 * Each event start is announced once (state survives restarts).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import { readEvents, type CalendarSource } from '../integrations/calendar/actions.js';
import type { CalendarEvent } from '../integrations/calendar/types.js';

export interface CalendarRemindersOptions {
  source: CalendarSource;
  leadMinutes: number;
  timeZone: () => string;
  notifyOwner: (text: string) => Promise<unknown>;
  logger: Logger;
  stateFile?: string;
  /** Poll period. Default 5 minutes. */
  intervalMs?: number;
  now?: () => Date;
}

export function defaultRemindersStateFile(): string {
  return join(process.env.SCALLOPBOT_DATA_DIR || join(homedir(), '.scallopbot'), 'calendar-reminders.json');
}

export function formatHeadsUp(event: CalendarEvent, now: Date, timeZone: string): string {
  const start = new Date(event.start);
  const minutes = Math.max(0, Math.round((start.getTime() - now.getTime()) / 60_000));
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(start);
  const where = event.location ? ` (${event.location})` : '';
  return `Coming up in ${minutes} min: ${event.title} at ${time}${where}`;
}

export class CalendarReminders {
  private timer: NodeJS.Timeout | null = null;
  private announced: Record<string, number> | null = null;
  private readonly stateFile: string;

  constructor(private readonly options: CalendarRemindersOptions) {
    this.stateFile = options.stateFile ?? defaultRemindersStateFile();
  }

  start(): void {
    if (this.timer) return;
    const run = () => void this.checkOnce().catch(error =>
      this.options.logger.warn({ error: (error as Error).message }, 'Calendar heads-up check failed'));
    run();
    this.timer = setInterval(run, this.options.intervalMs ?? 5 * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private load(): Record<string, number> {
    if (this.announced) return this.announced;
    try {
      this.announced = existsSync(this.stateFile)
        ? JSON.parse(readFileSync(this.stateFile, 'utf8')) as Record<string, number>
        : {};
    } catch {
      this.announced = {};
    }
    return this.announced;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.announced ?? {}), { mode: 0o600 });
      renameSync(tmp, this.stateFile);
    } catch {
      // Best effort: worst case an event is announced twice after a restart.
    }
  }

  /** Returns the number of heads-up messages sent. */
  async checkOnce(): Promise<number> {
    const now = this.options.now?.() ?? new Date();
    const leadMs = this.options.leadMinutes * 60_000;
    const timeZone = this.options.timeZone();
    const events = await readEvents(this.options.source, {
      from: now,
      to: new Date(now.getTime() + leadMs + 60_000),
      limit: 50,
      timeZone,
    });
    const announced = this.load();
    // Forget announcements for events that started over a day ago.
    for (const [key, startMs] of Object.entries(announced)) {
      if (startMs < now.getTime() - 86_400_000) delete announced[key];
    }
    let sent = 0;
    for (const event of events) {
      if (event.allDay || event.status === 'cancelled') continue;
      const startMs = new Date(event.start).getTime();
      if (startMs <= now.getTime() || startMs - now.getTime() > leadMs) continue;
      const key = `${event.id}@${event.start}`;
      if (announced[key]) continue;
      announced[key] = startMs;
      this.save();
      await this.options.notifyOwner(formatHeadsUp(event, now, timeZone));
      sent++;
    }
    this.save();
    return sent;
  }
}
