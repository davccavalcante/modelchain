import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStateBackend } from '../../src/state/file.js';
import { MemoryStateBackend } from '../../src/state/memory.js';
import type { StateSnapshot } from '../../src/types.js';

const snap: StateSnapshot = {
  models: {
    a: {
      healthScore: 80,
      avgLatencyMs: 100,
      avgQualityScore: 0.5,
      successCount: 1,
      failureCount: 0,
      consecutiveFailures: 0,
      cooldownUntil: 0,
      totalCostUsd: 0.001,
    },
  },
  spentTodayUsd: 0.001,
  day: '2026-01-01',
};

describe('MemoryStateBackend', () => {
  it('round-trips a snapshot', async () => {
    const b = new MemoryStateBackend();
    expect(await b.load()).toBeNull();
    await b.save(snap);
    expect(await b.load()).toEqual(snap);
  });

  it('has a name', () => {
    expect(new MemoryStateBackend().name).toBe('memory');
  });
});

describe('FileStateBackend', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'modelchain-state-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when the file does not exist', async () => {
    const b = new FileStateBackend(join(dir, 'state.json'));
    expect(await b.load()).toBeNull();
  });

  it('round-trips a snapshot', async () => {
    const b = new FileStateBackend(join(dir, 'state.json'));
    await b.save(snap);
    expect(await b.load()).toEqual(snap);
  });

  it('creates missing parent directories on save', async () => {
    const b = new FileStateBackend(join(dir, 'nested/deep/state.json'));
    await b.save(snap);
    expect(await b.load()).toEqual(snap);
  });

  it('writes JSON without raw keys or raw responses', async () => {
    const path = join(dir, 'state.json');
    await new FileStateBackend(path).save(snap);
    const raw = await readFile(path, 'utf-8');
    expect(raw).not.toContain('sk-');
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('prompt');
  });

  it('returns null on malformed JSON', async () => {
    const path = join(dir, 'state.json');
    const b = new FileStateBackend(path);
    await b.save(snap);
    await writeFile(path, '{not json', 'utf-8');
    expect(await b.load()).toBeNull();
  });

  it('returns null when shape is wrong', async () => {
    const path = join(dir, 'state.json');
    await writeFile(path, JSON.stringify({ foo: 'bar' }), 'utf-8');
    expect(await new FileStateBackend(path).load()).toBeNull();
  });

  it('has a name', () => {
    expect(new FileStateBackend(join(dir, 'x.json')).name).toBe('file');
  });
});
