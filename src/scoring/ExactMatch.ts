import type {
  CompletionRequest,
  CompletionResponse,
  ScoringResult,
  ScoringStrategy,
} from '../types.js';

/** Score 1.0 when text equals `request.metadata.expected` (trimmed). No-op without `expected`. */
export class ExactMatchScorer implements ScoringStrategy {
  public readonly name = 'exact-match';
  private readonly trim: boolean;

  public constructor(trim = true) {
    this.trim = trim;
  }

  public score(request: CompletionRequest, response: CompletionResponse): ScoringResult {
    const expected = request.metadata?.expected;
    if (expected === undefined) {
      return { scorer: this.name, score: 1, metadata: { skipped: true } };
    }
    const a = this.trim ? response.text.trim() : response.text;
    const b = this.trim ? expected.trim() : expected;
    return {
      scorer: this.name,
      score: a === b ? 1 : 0,
      metadata: { matched: a === b },
    };
  }
}
