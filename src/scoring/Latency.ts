import type {
  CompletionRequest,
  CompletionResponse,
  ScoringResult,
  ScoringStrategy,
} from '../types.js';

/** Score by latency, linear from 1.0 at target ms down to 0.0 at 4x target. */
export class LatencyScorer implements ScoringStrategy {
  public readonly name = 'latency';
  private readonly targetMs: number;

  public constructor(targetMs = 1500) {
    this.targetMs = Math.max(1, targetMs);
  }

  public score(_request: CompletionRequest, response: CompletionResponse): ScoringResult {
    const ratio = response.latencyMs / this.targetMs;
    let raw: number;
    if (ratio <= 1) raw = 1;
    else if (ratio >= 4) raw = 0;
    else raw = 1 - (ratio - 1) / 3;
    return {
      scorer: this.name,
      score: Math.max(0, Math.min(1, raw)),
      metadata: { latencyMs: response.latencyMs, targetMs: this.targetMs },
    };
  }
}
