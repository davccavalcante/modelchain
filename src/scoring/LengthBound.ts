import type {
  CompletionRequest,
  CompletionResponse,
  ScoringResult,
  ScoringStrategy,
} from '../types.js';

/** Score 1.0 when response length is within [minChars, maxChars], 0 otherwise. */
export class LengthBoundScorer implements ScoringStrategy {
  public readonly name = 'length-bound';
  private readonly minChars: number;
  private readonly maxChars: number;

  public constructor(minChars = 1, maxChars = 50_000) {
    this.minChars = Math.max(0, minChars);
    this.maxChars = Math.max(this.minChars, maxChars);
  }

  public score(_request: CompletionRequest, response: CompletionResponse): ScoringResult {
    const len = response.text.length;
    const passed = len >= this.minChars && len <= this.maxChars;
    return {
      scorer: this.name,
      score: passed ? 1 : 0,
      metadata: { length: len, minChars: this.minChars, maxChars: this.maxChars },
    };
  }
}
