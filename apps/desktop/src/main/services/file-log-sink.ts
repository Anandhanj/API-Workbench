import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DispatchEvent, LogLevel } from '@shared/ipc-contract';
import type { DispatchLogger } from './logger';

/**
 * Persists every logged {@link DispatchEvent} to a per-day file so problems can
 * be diagnosed after the fact (crashes, renderer faults, failed IPC calls).
 *
 * A new file is created for each calendar date — `app-YYYY-MM-DD.log` — using the
 * local date, and the writer rolls over automatically when the date changes while
 * the app is running. The newest `maxFiles` days are retained; older files are
 * pruned. It subscribes to the shared {@link DispatchLogger} and appends one JSON
 * line per event.
 *
 * Writes are synchronous on purpose: log volume is low, and a sync append
 * guarantees the final line reaches disk even when the process is about to die
 * (e.g. from an uncaught exception) — the exact case where the log matters most.
 *
 * Electron-free (takes a plain directory) and clock-injectable, so it is
 * unit-testable against a temp dir; the main process supplies the OS log
 * directory and the real clock.
 */

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Local-time `YYYY-MM-DD` stamp used in the file name (lexically sortable). */
function dateStamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface FileLogSinkOptions {
  /** File-name prefix; the active file is `${prefix}-YYYY-MM-DD.log`. Default `app`. */
  prefix?: string;
  /** Number of dated files (days) to retain; older ones are pruned. Default 14. */
  maxFiles?: number;
  /** Lowest level to persist. Default `debug` (everything). */
  minLevel?: LogLevel;
  /** Clock injection for deterministic tests. Default `() => new Date()`. */
  now?: () => Date;
}

export class FileLogSink {
  private readonly dir: string;
  private readonly prefix: string;
  private readonly maxFiles: number;
  private readonly minLevel: LogLevel;
  private readonly now: () => Date;
  /** Date stamp of the file last written to, so we can detect a day rollover. */
  private currentStamp: string;
  /** Set once if the filesystem becomes unwritable, to stop retrying every event. */
  private disabled = false;

  constructor(dir: string, options: FileLogSinkOptions = {}) {
    this.dir = dir;
    this.prefix = options.prefix ?? 'app';
    this.maxFiles = Math.max(1, options.maxFiles ?? 14);
    this.minLevel = options.minLevel ?? 'debug';
    this.now = options.now ?? (() => new Date());

    mkdirSync(dir, { recursive: true });
    this.currentStamp = dateStamp(this.now());
    this.prune();
  }

  /** Absolute path of the active file for the current date. */
  get filePath(): string {
    return join(this.dir, `${this.prefix}-${dateStamp(this.now())}.log`);
  }

  /** Deletes dated log files beyond the `maxFiles` most recent. */
  private prune(): void {
    const pattern = new RegExp(`^${escapeRegExp(this.prefix)}-\\d{4}-\\d{2}-\\d{2}\\.log$`);
    const files = readdirSync(this.dir)
      .filter((f) => pattern.test(f))
      .sort(); // `YYYY-MM-DD` sorts chronologically as text
    for (const stale of files.slice(0, Math.max(0, files.length - this.maxFiles))) {
      unlinkSync(join(this.dir, stale));
    }
  }

  /** Appends one event as a JSON line to the current day's file. */
  write(event: DispatchEvent): void {
    if (this.disabled || LEVEL_ORDER[event.level] < LEVEL_ORDER[this.minLevel]) return;
    try {
      const stamp = dateStamp(this.now());
      const rolledOver = stamp !== this.currentStamp;
      this.currentStamp = stamp;
      appendFileSync(join(this.dir, `${this.prefix}-${stamp}.log`), `${JSON.stringify(event)}\n`);
      // On a day rollover, prune after writing so the fresh file is counted.
      if (rolledOver) this.prune();
    } catch (error) {
      // Never let logging crash the app; stop trying so we don't spam failures.
      this.disabled = true;
      // eslint-disable-next-line no-console
      console.error('[file-log] disabled after write failure:', error);
    }
  }

  /**
   * Subscribes to a logger's event stream. Returns a disposer that detaches the
   * listener (call on shutdown / window teardown).
   */
  attach(logger: DispatchLogger): () => void {
    const handler = (event: DispatchEvent): void => this.write(event);
    logger.on('event', handler);
    return () => logger.off('event', handler);
  }
}
