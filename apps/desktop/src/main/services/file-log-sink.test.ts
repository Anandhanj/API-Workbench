// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DispatchLogger } from './logger';
import { FileLogSink } from './file-log-sink';

describe('FileLogSink', () => {
  let dir: string;

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), 'awb-filelog-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const readLines = (path: string): unknown[] =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  it('writes to a file named with the current date', () => {
    const logger = new DispatchLogger();
    const sink = new FileLogSink(dir, { now: () => new Date(2026, 6, 2, 10, 0, 0) });
    sink.attach(logger);

    logger.info('app', 'started');

    expect(basename(sink.filePath)).toBe('app-2026-07-02.log');
    const lines = readLines(sink.filePath);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', source: 'app', message: 'started' });
  });

  it('appends each logged event as a JSON line', () => {
    const logger = new DispatchLogger();
    const sink = new FileLogSink(dir, { now: () => new Date(2026, 0, 5) });
    sink.attach(logger);

    logger.info('app', 'one');
    logger.error('ipc', 'boom', { code: 42 });

    const lines = readLines(sink.filePath);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ level: 'error', source: 'ipc', context: { code: 42 } });
  });

  it('rolls over to a new dated file when the day changes', () => {
    const logger = new DispatchLogger();
    let clock = new Date(2026, 6, 2, 23, 59, 0);
    const sink = new FileLogSink(dir, { now: () => clock });
    sink.attach(logger);

    logger.info('app', 'before midnight');
    clock = new Date(2026, 6, 3, 0, 1, 0);
    logger.info('app', 'after midnight');

    const day1 = readLines(join(dir, 'app-2026-07-02.log')) as Array<{ message: string }>;
    const day2 = readLines(join(dir, 'app-2026-07-03.log')) as Array<{ message: string }>;
    expect(day1.map((l) => l.message)).toEqual(['before midnight']);
    expect(day2.map((l) => l.message)).toEqual(['after midnight']);
  });

  it('retains only the newest maxFiles days, pruning older ones', () => {
    const logger = new DispatchLogger();
    let day = 1;
    const sink = new FileLogSink(dir, { maxFiles: 2, now: () => new Date(2026, 0, day) });
    sink.attach(logger);

    for (day = 1; day <= 4; day += 1) logger.info('app', `day ${day}`);

    const files = readdirSync(dir).sort();
    expect(files).toEqual(['app-2026-01-03.log', 'app-2026-01-04.log']);
  });

  it('honours minLevel', () => {
    const logger = new DispatchLogger();
    const sink = new FileLogSink(dir, { minLevel: 'warn', now: () => new Date(2026, 0, 1) });
    sink.attach(logger);

    logger.debug('a', 'd');
    logger.info('a', 'i');
    logger.warn('a', 'w');
    logger.error('a', 'e');

    const lines = readLines(sink.filePath) as Array<{ level: string }>;
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('detaches on dispose and stops writing', () => {
    const logger = new DispatchLogger();
    const sink = new FileLogSink(dir, { now: () => new Date(2026, 0, 1) });
    const detach = sink.attach(logger);

    logger.info('app', 'first');
    detach();
    logger.info('app', 'second');

    const lines = readLines(sink.filePath) as Array<{ message: string }>;
    expect(lines.map((l) => l.message)).toEqual(['first']);
  });

  it('never throws into the app when the filesystem write fails', () => {
    const logger = new DispatchLogger();
    const sink = new FileLogSink(dir);
    sink.attach(logger);
    const spy = vi.spyOn(sink, 'write');
    rmSync(dir, { recursive: true, force: true });
    expect(() => logger.error('app', 'after dir removed')).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });
});
