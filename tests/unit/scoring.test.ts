import { describe, expect, it } from 'vitest';
import { ExactMatchScorer } from '../../src/scoring/ExactMatch.js';
import { buildScorer } from '../../src/scoring/index.js';
import { LatencyScorer } from '../../src/scoring/Latency.js';
import { LengthBoundScorer } from '../../src/scoring/LengthBound.js';
import { RegexMatchScorer } from '../../src/scoring/RegexMatch.js';
import { SchemaValidScorer } from '../../src/scoring/SchemaValid.js';
import { TokenBudgetScorer } from '../../src/scoring/TokenBudget.js';
import type { CompletionRequest, CompletionResponse } from '../../src/types.js';

const req = (overrides: Partial<CompletionRequest> = {}): CompletionRequest => ({
  prompt: 'hello',
  ...overrides,
});

const res = (overrides: Partial<CompletionResponse> = {}): CompletionResponse => ({
  text: 'world',
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  modelId: 'm' as never,
  providerName: 'p',
  latencyMs: 100,
  ...overrides,
});

describe('scoring', () => {
  describe('LatencyScorer', () => {
    const s = new LatencyScorer(1000);
    it('scores 1 at or below target', () => {
      expect(s.score(req(), res({ latencyMs: 500 })).score).toBe(1);
      expect(s.score(req(), res({ latencyMs: 1000 })).score).toBe(1);
    });
    it('scores 0 at or beyond 4x target', () => {
      expect(s.score(req(), res({ latencyMs: 4000 })).score).toBe(0);
      expect(s.score(req(), res({ latencyMs: 10_000 })).score).toBe(0);
    });
    it('interpolates between 1x and 4x', () => {
      const r = s.score(req(), res({ latencyMs: 2000 }));
      expect(r.score).toBeGreaterThan(0.5);
      expect(r.score).toBeLessThan(1);
    });
  });

  describe('TokenBudgetScorer', () => {
    const s = new TokenBudgetScorer();
    it('scores 1 for under 25% usage', () => {
      expect(
        s.score(
          req({ maxTokens: 1000 }),
          res({ usage: { inputTokens: 0, outputTokens: 100, totalTokens: 100 } }),
        ).score,
      ).toBe(1);
    });
    it('scores 0 for over-the-limit', () => {
      expect(
        s.score(
          req({ maxTokens: 100 }),
          res({ usage: { inputTokens: 0, outputTokens: 200, totalTokens: 200 } }),
        ).score,
      ).toBe(0);
    });
    it('scores in middle range', () => {
      const r = s.score(
        req({ maxTokens: 1000 }),
        res({ usage: { inputTokens: 0, outputTokens: 500, totalTokens: 500 } }),
      );
      expect(r.score).toBeGreaterThan(0.5);
      expect(r.score).toBeLessThan(1);
    });
  });

  describe('LengthBoundScorer', () => {
    const s = new LengthBoundScorer(2, 10);
    it('passes within bounds', () => {
      expect(s.score(req(), res({ text: 'okok' })).score).toBe(1);
    });
    it('fails below min', () => {
      expect(s.score(req(), res({ text: 'a' })).score).toBe(0);
    });
    it('fails above max', () => {
      expect(s.score(req(), res({ text: 'x'.repeat(50) })).score).toBe(0);
    });
  });

  describe('RegexMatchScorer', () => {
    it('matches when must-match=true', () => {
      const s = new RegexMatchScorer(/hello/, true);
      expect(s.score(req(), res({ text: 'hello world' })).score).toBe(1);
      expect(s.score(req(), res({ text: 'bye' })).score).toBe(0);
    });
    it('inverts when must-match=false', () => {
      const s = new RegexMatchScorer(/forbidden/, false);
      expect(s.score(req(), res({ text: 'clean' })).score).toBe(1);
      expect(s.score(req(), res({ text: 'forbidden word' })).score).toBe(0);
    });
  });

  describe('ExactMatchScorer', () => {
    const s = new ExactMatchScorer();
    it('returns 1 when no expected metadata', () => {
      expect(s.score(req(), res({ text: 'anything' })).score).toBe(1);
    });
    it('matches expected after trimming', () => {
      expect(s.score(req({ metadata: { expected: 'hi' } }), res({ text: '  hi  ' })).score).toBe(1);
    });
    it('returns 0 on mismatch', () => {
      expect(s.score(req({ metadata: { expected: 'hi' } }), res({ text: 'bye' })).score).toBe(0);
    });
  });

  describe('SchemaValidScorer', () => {
    it('scores 1 for valid JSON object', () => {
      expect(new SchemaValidScorer().score(req(), res({ text: '{"ok":true}' })).score).toBe(1);
    });
    it('scores 0 for invalid JSON', () => {
      expect(new SchemaValidScorer().score(req(), res({ text: '{not-json' })).score).toBe(0);
    });
    it('scores 0 for array (not object)', () => {
      expect(new SchemaValidScorer().score(req(), res({ text: '[1,2,3]' })).score).toBe(0);
    });
    it('validates required keys', () => {
      const s = new SchemaValidScorer({ required: ['a', 'b'] });
      expect(s.score(req(), res({ text: '{"a":1,"b":2}' })).score).toBe(1);
      expect(s.score(req(), res({ text: '{"a":1}' })).score).toBe(0);
    });
    it('validates types', () => {
      const s = new SchemaValidScorer({
        types: { n: 'number', s: 'string', b: 'boolean', a: 'array', o: 'object' },
      });
      expect(s.score(req(), res({ text: '{"n":1,"s":"x","b":true,"a":[],"o":{}}' })).score).toBe(1);
      expect(s.score(req(), res({ text: '{"n":"wrong"}' })).score).toBe(0);
    });
  });

  describe('buildScorer', () => {
    it('builds every named scorer', () => {
      const names = [
        'latency',
        'token-budget',
        'length-bound',
        'regex-match',
        'exact-match',
        'schema-valid',
      ] as const;
      for (const n of names) {
        expect(buildScorer(n).name).toBe(n);
      }
    });
  });
});
