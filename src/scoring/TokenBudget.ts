import type {
  CompletionRequest,
  CompletionResponse,
  ScoringResult,
  ScoringStrategy,
} from '../types.js';

/** Score by efficient use of the `maxTokens` budget. Truncation scores 0. */
export class TokenBudgetScorer implements ScoringStrategy {
  public readonly name = 'token-budget';
  private readonly targetOutputTokens: number;

  public constructor(targetOutputTokens = 512) {
    this.targetOutputTokens = Math.max(1, targetOutputTokens);
  }

  public score(request: CompletionRequest, response: CompletionResponse): ScoringResult {
    const limit = request.maxTokens ?? this.targetOutputTokens;
    const used = response.usage.outputTokens;
    const ratio = used / limit;
    let raw: number;
    if (ratio < 0.25) raw = 1;
    else if (ratio < 0.9) raw = 1 - ((ratio - 0.25) / 0.65) * 0.5;
    else if (ratio < 1.0) raw = 0.5 - ((ratio - 0.9) / 0.1) * 0.5;
    else raw = 0;
    return {
      scorer: this.name,
      score: Math.max(0, Math.min(1, raw)),
      metadata: { outputTokens: used, limit },
    };
  }
}
