import { describe, expect, it } from 'vitest';
import { CostFirst } from '../../src/strategies/CostFirst.js';
import { CostThenQuality } from '../../src/strategies/CostThenQuality.js';
import { buildStrategy } from '../../src/strategies/index.js';
import { LatencyFirst } from '../../src/strategies/LatencyFirst.js';
import { QualityFirst } from '../../src/strategies/QualityFirst.js';
import { RoundRobin } from '../../src/strategies/RoundRobin.js';
import { SequentialFallback } from '../../src/strategies/SequentialFallback.js';
import { Weighted } from '../../src/strategies/Weighted.js';
import type {
  CompletionRequest,
  ModelDefinition,
  ModelSnapshot,
  ProviderAdapter,
} from '../../src/types.js';

const noopProvider: ProviderAdapter = {
  name: 'noop',
  complete: () => Promise.reject(new Error('not used')),
  stream: async function* () {},
  parseError: () => ({ classification: 'unknown', message: '' }),
};

const def = (id: string, costIn: number, costOut: number, weight = 1): ModelDefinition => ({
  id,
  provider: noopProvider,
  cost: { costPer1kInput: costIn, costPer1kOutput: costOut },
  keys: 'sk',
  weight,
});

const snap = (id: string, overrides: Partial<ModelSnapshot> = {}): ModelSnapshot => ({
  id,
  providerName: 'noop',
  circuitState: 'closed',
  healthScore: 100,
  inFlight: 0,
  successCount: 0,
  failureCount: 0,
  consecutiveFailures: 0,
  cooldownUntil: 0,
  lastUsedAt: 0,
  avgLatencyMs: 0,
  avgQualityScore: null,
  totalCostUsd: 0,
  ...overrides,
});

const req = (): CompletionRequest => ({ prompt: 'x' });

describe('strategies', () => {
  describe('RoundRobin', () => {
    it('rotates through candidates', () => {
      const s = new RoundRobin();
      const c = [snap('a'), snap('b'), snap('c')];
      expect(s.select(c)).toBe('a');
      expect(s.select(c)).toBe('b');
      expect(s.select(c)).toBe('c');
      expect(s.select(c)).toBe('a');
    });
    it('returns null on empty pool', () => {
      expect(new RoundRobin().select([])).toBeNull();
    });
  });

  describe('Weighted', () => {
    it('always picks the only candidate', () => {
      const s = new Weighted([def('a', 0, 0, 1)]);
      expect(s.select([snap('a')])).toBe('a');
    });
    it('returns null on empty pool', () => {
      expect(new Weighted([def('a', 0, 0, 1)]).select([])).toBeNull();
    });
    it('falls back to first when all weights are zero', () => {
      const s = new Weighted([def('a', 0, 0, 0), def('b', 0, 0, 0)]);
      expect(s.select([snap('a'), snap('b')])).toBe('a');
    });
  });

  describe('CostFirst', () => {
    it('picks the cheapest', () => {
      const s = new CostFirst([def('cheap', 0.001, 0.001), def('pricey', 1, 1)]);
      expect(s.select([snap('cheap'), snap('pricey')])).toBe('cheap');
    });
    it('returns null on empty pool', () => {
      expect(new CostFirst([]).select([])).toBeNull();
    });
  });

  describe('QualityFirst', () => {
    it('prefers the highest observed quality', () => {
      const s = new QualityFirst();
      expect(
        s.select([snap('low', { avgQualityScore: 0.3 }), snap('high', { avgQualityScore: 0.9 })]),
      ).toBe('high');
    });
    it('falls back to healthScore on cold start', () => {
      const s = new QualityFirst();
      expect(s.select([snap('a', { healthScore: 60 }), snap('b', { healthScore: 90 })])).toBe('b');
    });
    it('returns null on empty pool', () => {
      expect(new QualityFirst().select([])).toBeNull();
    });
  });

  describe('CostThenQuality', () => {
    it('picks the cheapest meeting the quality floor', () => {
      const s = new CostThenQuality(
        [def('cheap-low', 0.001, 0.001), def('cheap-high', 0.002, 0.002), def('exp-high', 1, 1)],
        0.7,
      );
      expect(
        s.select([
          snap('cheap-low', { avgQualityScore: 0.5 }),
          snap('cheap-high', { avgQualityScore: 0.8 }),
          snap('exp-high', { avgQualityScore: 0.95 }),
        ]),
      ).toBe('cheap-high');
    });
    it('falls back to cheapest when no one meets the floor', () => {
      const s = new CostThenQuality([def('cheap', 0.001, 0.001), def('exp', 1, 1)], 0.95);
      expect(
        s.select([snap('cheap', { avgQualityScore: 0.6 }), snap('exp', { avgQualityScore: 0.7 })]),
      ).toBe('cheap');
    });
    it('treats cold-start models as meeting the floor', () => {
      const s = new CostThenQuality([def('cold', 0.001, 0.001), def('warm', 1, 1)], 0.9);
      expect(
        s.select([
          snap('cold', { avgQualityScore: null }),
          snap('warm', { avgQualityScore: 0.95 }),
        ]),
      ).toBe('cold');
    });
    it('returns null on empty pool', () => {
      expect(new CostThenQuality([def('a', 1, 1)]).select([])).toBeNull();
    });
  });

  describe('LatencyFirst', () => {
    it('prefers unseen models first', () => {
      const s = new LatencyFirst();
      expect(
        s.select([
          snap('fast', { avgLatencyMs: 100, successCount: 5 }),
          snap('unseen', { avgLatencyMs: 0, successCount: 0 }),
        ]),
      ).toBe('unseen');
    });
    it('picks the lowest latency once warmed up', () => {
      const s = new LatencyFirst();
      expect(
        s.select([
          snap('slow', { avgLatencyMs: 500, successCount: 1 }),
          snap('fast', { avgLatencyMs: 100, successCount: 1 }),
        ]),
      ).toBe('fast');
    });
    it('returns null on empty pool', () => {
      expect(new LatencyFirst().select([])).toBeNull();
    });
  });

  describe('SequentialFallback', () => {
    it('always picks the first candidate', () => {
      expect(new SequentialFallback().select([snap('a'), snap('b')])).toBe('a');
    });
    it('returns null on empty pool', () => {
      expect(new SequentialFallback().select([])).toBeNull();
    });
  });

  describe('buildStrategy', () => {
    it('builds every named strategy', () => {
      const m = [def('a', 1, 1)];
      const names = [
        'round-robin',
        'weighted',
        'cost-first',
        'quality-first',
        'cost-then-quality',
        'latency-first',
        'sequential-fallback',
      ] as const;
      for (const n of names) {
        expect(buildStrategy(n, m).name).toBe(n);
      }
    });
    it('strategy contract is invoked with a real request', () => {
      const s = buildStrategy('round-robin', [def('a', 1, 1)]);
      expect(s.select([snap('a')], req())).toBe('a');
    });
  });
});
