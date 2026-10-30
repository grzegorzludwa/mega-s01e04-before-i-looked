import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DigestRow, ReadNight, RunStatus, StatusCounts } from './types.js';

type RunEvent = {
  at: string;
  job: string;
  status: RunStatus;
  owner: string | null;
  error?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2})(?::?(\d{2}))?)$/.exec(value);
  if (!parts) return false;

  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = parts;
  const y = Number(year);
  const m = Number(month);
  const leapYear = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return m >= 1 && m <= 12
    && Number(day) >= 1 && Number(day) <= days[m - 1]
    && Number(hour) <= 23 && Number(minute) <= 59 && Number(second ?? 0) <= 59
    && Number(offsetHour ?? 0) <= 23 && Number(offsetMinute ?? 0) <= 59;
}

function isEvent(value: unknown): value is RunEvent {
  return isObject(value)
    && typeof value.job === 'string' && value.job.length > 0
    && isTimestamp(value.at)
    && (value.status === 'ok' || value.status === 'retry' || value.status === 'fail')
    && (typeof value.owner === 'string' || value.owner === null)
    && (!Object.hasOwn(value, 'error') || typeof value.error === 'string');
}

export const readNight: ReadNight = async (runsDir, night) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(night)) return null;

  let contents: string;
  try {
    contents = await readFile(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (error: unknown) {
    if (isObject(error) && error.code === 'ENOENT') return null;
    throw error;
  }

  const jobs = new Map<string, DigestRow>();
  const counts: StatusCounts = { ok: 0, retry: 0, fail: 0 };
  let badLines = 0;
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }
    if (!isEvent(event)) {
      badLines += 1;
      continue;
    }

    counts[event.status] += 1;
    let row = jobs.get(event.job);
    if (!row) {
      row = {
        job: event.job, owner: event.owner, runs: 0, retries: 0, failures: 0,
        lastStatus: event.status, lastError: null, firstAt: event.at, lastAt: event.at,
      };
      jobs.set(event.job, row);
    }
    row.owner = event.owner;
    row.runs += 1;
    row.retries += Number(event.status === 'retry');
    row.failures += Number(event.status === 'fail');
    row.lastStatus = event.status;
    if (event.error !== undefined) row.lastError = event.error;
    row.lastAt = event.at;
  }

  const rows = [...jobs.values()].sort((a, b) => a.job < b.job ? -1 : a.job > b.job ? 1 : 0);
  return { night, rows, badLines, counts };
};
