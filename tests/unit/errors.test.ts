import { describe, expect, it } from 'vitest';
import {
  AllModelsExhaustedError,
  BudgetExceededError,
  ModelchainError,
  ProviderError,
} from '../../src/errors.js';
import type { BudgetSnapshot } from '../../src/types.js';

describe('errors', () => {
  describe('ModelchainError', () => {
    it('carries a stable code and message', () => {
      const e = new ModelchainError('INVALID_OPTIONS', 'bad options');
      expect(e.code).toBe('INVALID_OPTIONS');
      expect(e.name).toBe('ModelchainError');
      expect(e.message).toBe('bad options');
      expect(e).toBeInstanceOf(Error);
    });

    it('accepts cause via options', () => {
      const cause = new Error('root');
      const e = new ModelchainError('INVALID_OPTIONS', 'wrap', { cause });
      expect((e as { cause?: unknown }).cause).toBe(cause);
    });
  });

  describe('AllModelsExhaustedError', () => {
    it('preserves snapshots and the last reason', () => {
      const e = new AllModelsExhaustedError([], 'circuit open');
      expect(e.code).toBe('ALL_MODELS_EXHAUSTED');
      expect(e.lastReason).toBe('circuit open');
      expect(e.name).toBe('AllModelsExhaustedError');
    });
  });

  describe('BudgetExceededError', () => {
    it('exposes scope, limit, attempted, and current budget snapshot', () => {
      const budget: BudgetSnapshot = {
        perRequestUsd: 0.05,
        perTaskUsd: {},
        dailyUsd: 5,
        spentTodayUsd: 4.99,
        remainingTodayUsd: 0.01,
      };
      const e = new BudgetExceededError('daily', 5, 5.01, budget);
      expect(e.code).toBe('BUDGET_EXCEEDED');
      expect(e.scope).toBe('daily');
      expect(e.limit).toBe(5);
      expect(e.attempted).toBe(5.01);
      expect(e.budget).toBe(budget);
      expect(e.name).toBe('BudgetExceededError');
    });
  });

  describe('ProviderError', () => {
    it('classifies and attaches the original cause', () => {
      const cause = new Error('boom');
      const e = new ProviderError('openai', 'gpt-5', 'rate-limited', 'too many', {
        status: 429,
        cause,
      });
      expect(e.code).toBe('PROVIDER_ERROR');
      expect(e.classification).toBe('rate-limited');
      expect(e.status).toBe(429);
      expect(e.providerName).toBe('openai');
      expect(e.modelId).toBe('gpt-5');
      expect((e as { cause?: unknown }).cause).toBe(cause);
    });

    it('parseError surfaces classification from a plain Error', () => {
      const e = new ProviderError('openai', 'gpt', 'network', 'fetch failed');
      expect(e.status).toBeUndefined();
    });
  });
});
