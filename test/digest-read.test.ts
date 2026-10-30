import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/read.js';

const night = '2026-10-28';
const at = '2026-10-28T23:00:02+01:00';
const base = { at, job: 'job', status: 'ok', owner: 'rook' };

describe('readNight', () => {
  let runsDir: string;
  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), 'rig-digest-reader-'));
  });
  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true });
  });

  async function writeEvents(events: unknown[]) {
    await writeFile(join(runsDir, `${night}.jsonl`), events.map(event => JSON.stringify(event)).join('\n'));
  }

  it('reads the immutable reference night with five sorted jobs and one bad line', async () => {
    const digest = await readNight(new URL('../runs/', import.meta.url).pathname, night);
    expect(digest).toEqual({
      night, badLines: 1, counts: { ok: 10, retry: 4, fail: 1 },
      rows: [
        { job: 'digest/render', owner: null, runs: 1, retries: 0, failures: 0, lastStatus: 'ok', lastError: null,
          firstAt: '2026-10-29T05:41:09+01:00', lastAt: '2026-10-29T05:41:09+01:00' },
        { job: 'fixtures/refresh', owner: 'rook', runs: 4, retries: 3, failures: 0, lastStatus: 'ok', lastError: 'upstream 503',
          firstAt: '2026-10-29T01:30:00+01:00', lastAt: '2026-10-29T01:37:00+01:00' },
        { job: 'lane/sync', owner: 'rook', runs: 8, retries: 1, failures: 0, lastStatus: 'ok', lastError: 'lock held',
          firstAt: '2026-10-28T23:00:06+01:00', lastAt: '2026-10-29T05:00:04+01:00' },
        { job: 'notes/backup', owner: 'lane-07', runs: 1, retries: 0, failures: 1, lastStatus: 'fail', lastError: 'quota exceeded',
          firstAt: '2026-10-29T04:00:01+01:00', lastAt: '2026-10-29T04:00:01+01:00' },
        { job: 'rig/rotate-logs', owner: 'lane-07', runs: 1, retries: 0, failures: 0, lastStatus: 'ok', lastError: null,
          firstAt: at, lastAt: at },
      ],
    });
  });

  it('aggregates in file order, retains failures and errors after success, and replaces owner with null', async () => {
    const firstAt = '2026-10-29T03:12:04.123456-07:30';
    const lastAt = '2026-10-28T21:00:00Z';
    await writeEvents([
      { ...base, at: firstAt, status: 'fail', error: 'first failure' },
      { ...base, at: firstAt, status: 'retry', error: 'latest error' },
      { ...base, at: lastAt, owner: null, extra: { ignored: true } },
    ]);
    expect(await readNight(runsDir, night)).toEqual({
      night, badLines: 0, counts: { ok: 1, retry: 1, fail: 1 },
      rows: [{ job: 'job', owner: null, runs: 3, retries: 1, failures: 1, lastStatus: 'ok',
        lastError: 'latest error', firstAt, lastAt }],
    });
  });

  it('keeps an explicitly empty error string and owner', async () => {
    await writeEvents([{ ...base, error: 'old' }, { ...base, owner: '', error: '' }, { ...base, owner: '' }]);
    expect((await readNight(runsDir, night))?.rows[0]).toMatchObject({ lastError: '', owner: '', runs: 3 });
  });

  it('handles prototype-like job names and sorts with case-sensitive JS comparison', async () => {
    await writeEvents(['ä', 'z', '__proto__', 'constructor', 'toString', 'A', 'a'].map(job => ({ ...base, job })));
    const digest = await readNight(runsDir, night);
    expect(digest?.rows.map(row => row.job)).toEqual(['A', '__proto__', 'a', 'constructor', 'toString', 'z', 'ä']);
    expect(digest?.counts).toEqual({ ok: 7, retry: 0, fail: 0 });
  });

  it('counts malformed JSON and invalid objects once each without losing surrounding events', async () => {
    const invalid: unknown[] = [
      null, false, 7, 'text', [], [base], {},
      { ...base, at: undefined }, { ...base, at: 42 }, { ...base, at: 'yesterday' },
      { ...base, at: '2026-10-28T23:00:00' }, { ...base, at: '2026-02-29T00:00:00Z' },
      { ...base, at: '2026-04-31T00:00:00Z' }, { ...base, at: '2026-13-01T00:00:00Z' },
      { ...base, at: '2026-10-00T00:00:00Z' }, { ...base, at: '2026-10-28T25:00:00Z' },
      { ...base, at: '2026-10-28T00:60:00Z' }, { ...base, at: '2026-10-28T00:00:61Z' },
      { ...base, at: '2026-10-28T00:00:00+24:00' }, { ...base, at: '2026-10-28T00:00:00+01:60' },
      { ...base, job: '' }, { ...base, job: 1 }, { ...base, job: null }, { ...base, job: undefined },
      { ...base, status: 'success' }, { ...base, status: '__proto__' }, { ...base, status: null },
      { ...base, status: undefined }, { ...base, owner: undefined }, { ...base, owner: 0 },
      { ...base, owner: {} }, { ...base, error: null }, { ...base, error: [] }, { ...base, error: 0 },
    ];
    const lines = [JSON.stringify(base), '{broken', ...invalid.map(event => JSON.stringify(event)), JSON.stringify(base)];
    await writeFile(join(runsDir, `${night}.jsonl`), lines.join('\r\n') + '\r\n');
    const digest = await readNight(runsDir, night);
    expect(digest?.badLines).toBe(invalid.length + 1);
    expect(digest?.counts).toEqual({ ok: 2, retry: 0, fail: 0 });
    expect(digest?.rows).toHaveLength(1);
    expect(digest?.rows[0].runs).toBe(2);
  });

  it('accepts leap days and preserves explicit offsets and fractional seconds', async () => {
    const timestamps = ['2024-02-29T00:00:00Z', '2026-10-28T23:59:59.987654+05:45', '2026-10-28T10:15-0330'];
    await writeEvents(timestamps.map((timestamp, index) => ({ ...base, job: String(index), at: timestamp })));
    const digest = await readNight(runsDir, night);
    expect(digest?.badLines).toBe(0);
    expect(digest?.rows.map(row => [row.firstAt, row.lastAt])).toEqual(timestamps.map(timestamp => [timestamp, timestamp]));
  });

  it.each(['', '\n \t\r\n\n'])('returns an empty digest for an empty or blank-only file', async contents => {
    await writeFile(join(runsDir, `${night}.jsonl`), contents);
    expect(await readNight(runsDir, night)).toEqual({ night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
  });

  it('keeps an all-malformed file distinct from a missing file', async () => {
    await writeFile(join(runsDir, `${night}.jsonl`), 'bad\nnull\n{}\n\n');
    expect(await readNight(runsDir, night)).toEqual({ night, rows: [], badLines: 3, counts: { ok: 0, retry: 0, fail: 0 } });
    expect(await readNight(runsDir, '2026-10-27')).toBeNull();
    expect(await readNight(join(runsDir, 'missing'), night)).toBeNull();
  });

  it.each(['', '../2026-10-28', '/2026-10-28', '2026-1-28', '2026-10-28.jsonl', '2026-10-28\n', '2026-10-28\0'])('rejects invalid night %j before accessing disk', async invalidNight => {
    // Accessing this path would reject with ENOTDIR if the identifier reached disk.
    const notDirectory = join(runsDir, 'file');
    await writeFile(notDirectory, '');
    expect(await readNight(notDirectory, invalidNight)).toBeNull();
  });

  it('rejects other I/O errors instead of reporting a missing night', async () => {
    await mkdir(join(runsDir, `${night}.jsonl`));
    await expect(readNight(runsDir, night)).rejects.toMatchObject({ code: 'EISDIR' });
    const notDirectory = join(runsDir, 'file');
    await writeFile(notDirectory, '');
    await expect(readNight(notDirectory, night)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});
