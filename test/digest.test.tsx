import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { NightDigest } from '../src/digest/types.js';

const config = {
  adapter: 'shim',
  installed: '2026-10-29T14:06:00+01:00',
  beatEverySeconds: 60,
  runsDir: '',
};

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'rig-digest-'));
  vi.stubEnv('LANE_MARKER', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(runsDir, { recursive: true, force: true });
});

async function writeNight(night: string, contents: string): Promise<void> {
  await writeFile(join(runsDir, `${night}.jsonl`), contents, 'utf8');
}

function app() {
  return createApp({ ...config, runsDir });
}

function tableRows(html: string): { cells: { className: string; text: string }[] }[] {
  const table = html.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!table) throw new Error('digest page did not render a table');

  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].slice(1).map((row) => ({
    cells: [...row[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => ({
      className: cell[1].match(/\bclass="([^"]*)"/)?.[1] ?? '',
      text: cell[2]
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&#x27;/g, "'"),
    })),
  }));
}

describe('digest routes', () => {
  it('returns 404 from both routes when the night file is missing', async () => {
    const page = await app().request('/digest/2026-10-30');
    const json = await app().request('/api/digest/2026-10-30');

    expect(page.status).toBe(404);
    expect(json.status).toBe(404);
  });

  it('renders an empty existing night in HTML and JSON', async () => {
    await writeNight('2026-10-30', '');

    const page = await app().request('/digest/2026-10-30');
    const html = await page.text();
    const json = await app().request('/api/digest/2026-10-30');

    expect(page.status).toBe(200);
    expect(html).toContain('nothing ran');
    expect(json.status).toBe(200);
    expect(await json.json()).toEqual({
      night: '2026-10-30',
      rows: [],
      badLines: 0,
      counts: { ok: 0, retry: 0, fail: 0 },
    });
  });

  it('counts malformed lines while keeping HTML and JSON rows in sorted order', async () => {
    await writeNight(
      '2026-10-30',
      [
        '{broken json',
        JSON.stringify({ at: '2026-10-30T08:10:00+05:30', job: 'zeta', status: 'ok', owner: null }),
        JSON.stringify({ at: '2026-10-30T07:00:00-04:00', job: 'alpha', status: 'fail', owner: 'A<&', error: '<disk>' }),
        JSON.stringify({ at: '2026-10-30T08:09:00+05:30', job: 'alpha', status: 'retry', owner: null }),
        JSON.stringify({ at: '2026-10-30T08:11:00+05:30', job: 'alpha', status: 'retry', owner: 'A<&' }),
        JSON.stringify({ at: '2026-10-30T08:12:00+05:30', job: 'alpha', status: 'retry', owner: 'A<&' }),
        JSON.stringify({ at: '2026-10-30T08:13:00+05:30', job: 'alpha', status: 'ok', owner: 'A<&' }),
        JSON.stringify({ at: '2026-10-30T08:14:00+05:30', job: 'beta', status: 'retry', owner: 'B' }),
        JSON.stringify({ at: '2026-10-30T08:15:00+05:30', job: 'beta', status: 'retry', owner: 'B' }),
        '',
      ].join('\n'),
    );

    const page = await app().request('/digest/2026-10-30');
    const html = await page.text();
    const jsonResponse = await app().request('/api/digest/2026-10-30');
    const digest = (await jsonResponse.json()) as NightDigest;

    expect(page.status).toBe(200);
    expect(jsonResponse.status).toBe(200);
    expect(digest.badLines).toBe(1);
    expect(digest.rows.map((row) => row.job)).toEqual(['alpha', 'beta', 'zeta']);
    expect(tableRows(html).map((row) => row.cells[0].text)).toEqual(digest.rows.map((row) => row.job));

    const alpha = digest.rows[0];
    expect(alpha).toMatchObject({
      owner: 'A<&', runs: 5, retries: 3, failures: 1, lastStatus: 'ok', lastError: '<disk>',
      firstAt: '2026-10-30T07:00:00-04:00', lastAt: '2026-10-30T08:13:00+05:30',
    });
    expect(digest.rows[1]).toMatchObject({ owner: 'B', retries: 2, failures: 0 });
    expect(digest.rows[2]).toMatchObject({ owner: null, firstAt: '2026-10-30T08:10:00+05:30' });
    const renderedRows = tableRows(html);
    expect(renderedRows[0].cells.some((cell) => /\bwarn\b/.test(cell.className))).toBe(true);
    expect(renderedRows[1].cells.some((cell) => /\bwarn\b/.test(cell.className))).toBe(false);
    expect(html).toMatch(/bad lines:\s*1/i);
    expect(html).toContain('—');
    expect(html).toContain('&lt;disk&gt;');
    expect(html).not.toContain('<disk>');
  });

  it('preserves a null owner and retained error in both representations', async () => {
    await writeNight(
      '2026-10-30',
      `${JSON.stringify({ at: '2026-10-30T01:02:03+02:00', job: 'worker', status: 'fail', owner: 'old', error: 'disk <full>' })}\n${JSON.stringify({ at: '2026-10-30T02:03:04+02:00', job: 'worker', status: 'ok', owner: null })}\n`,
    );

    const html = await (await app().request('/digest/2026-10-30')).text();
    const response = await app().request('/api/digest/2026-10-30');
    const digest = (await response.json()) as NightDigest;

    expect(response.status).toBe(200);
    expect(digest.rows[0]).toMatchObject({
      owner: null,
      lastError: 'disk <full>',
      firstAt: '2026-10-30T01:02:03+02:00',
      lastAt: '2026-10-30T02:03:04+02:00',
    });
    expect(tableRows(html)[0].cells.map((cell) => cell.text)).toContain('—');
    expect(tableRows(html)[0].cells.map((cell) => cell.text)).toContain('disk <full>');
    expect(tableRows(html)[0].cells[4].className).toMatch(/\bwarn\b/);
    expect(tableRows(html)[0].cells[5].className).toMatch(/\bwarn\b/);
    expect(html).toContain('&lt;full&gt;');
    expect(html).not.toContain('disk <full>');
  });
});
