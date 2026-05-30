import type {
  CompletionRequest,
  CompletionResponse,
  ScoringResult,
  ScoringStrategy,
} from '../types.js';

/** Score 1.0 when text matches the regex (or doesn't, if `mustMatch=false`). */
export class RegexMatchScorer implements ScoringStrategy {
  public readonly name = 'regex-match';
  private readonly pattern: RegExp;
  private readonly mustMatch: boolean;

  public constructor(pattern: RegExp, mustMatch = true) {
    this.pattern = pattern;
    this.mustMatch = mustMatch;
  }

  public score(_request: CompletionRequest, response: CompletionResponse): ScoringResult {
    const matched = this.pattern.test(response.text);
    const passed = this.mustMatch ? matched : !matched;
    return {
      scorer: this.name,
      score: passed ? 1 : 0,
      metadata: { pattern: this.pattern.source, mustMatch: this.mustMatch, matched },
    };
  }
}
