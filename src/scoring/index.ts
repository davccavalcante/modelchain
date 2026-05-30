import type { BuiltInScorerName, ScoringStrategy } from '../types.js';
import { ExactMatchScorer } from './ExactMatch.js';
import { LatencyScorer } from './Latency.js';
import { LengthBoundScorer } from './LengthBound.js';
import { RegexMatchScorer } from './RegexMatch.js';
import { SchemaValidScorer } from './SchemaValid.js';
import { TokenBudgetScorer } from './TokenBudget.js';

/** Build a scorer instance from its name. Throws on unknown name. */
export function buildScorer(name: BuiltInScorerName): ScoringStrategy {
  switch (name) {
    case 'latency':
      return new LatencyScorer();
    case 'token-budget':
      return new TokenBudgetScorer();
    case 'length-bound':
      return new LengthBoundScorer();
    case 'regex-match':
      return new RegexMatchScorer(/\S/);
    case 'exact-match':
      return new ExactMatchScorer();
    case 'schema-valid':
      return new SchemaValidScorer();
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown scorer: ${String(exhaustive)}`);
    }
  }
}

export {
  ExactMatchScorer,
  LatencyScorer,
  LengthBoundScorer,
  RegexMatchScorer,
  SchemaValidScorer,
  TokenBudgetScorer,
};
