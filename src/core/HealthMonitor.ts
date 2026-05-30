/**
 * Per-model health score with EWMA decay over time.
 *
 * Score range is [0, 100]. New models start at 100 (full trust). Successes
 * recover the score linearly toward 100, failures drop it proportionally.
 * Quality scores from `ScoringStrategy` outputs adjust the score by their
 * deviation from 1.0 - a 0.8 score nudges the EWMA score down, a 0.95 score
 * keeps it near 100.
 *
 * The EWMA weight is configurable. Defaults are tuned so a single outlier
 * cannot wreck the score, but a sustained trend converges within ~20 calls.
 *
 * Multi-runtime safe: uses `Date.now()` only.
 */
export class HealthMonitor {
  private readonly successWeight: number;
  private readonly failureWeight: number;
  private readonly qualityWeight: number;

  public constructor(successWeight = 0.1, failureWeight = 0.3, qualityWeight = 0.2) {
    this.successWeight = successWeight;
    this.failureWeight = failureWeight;
    this.qualityWeight = qualityWeight;
  }

  /** Returns the score after recording a success. */
  public recordSuccess(currentScore: number): number {
    return clamp(currentScore + (100 - currentScore) * this.successWeight);
  }

  /**
   * Returns the score after recording a failure.
   * `severity` in [0, 1] - 1.0 is the worst possible failure, 0.0 is benign.
   */
  public recordFailure(currentScore: number, severity: number): number {
    const clampedSeverity = Math.max(0, Math.min(1, severity));
    return clamp(currentScore - currentScore * this.failureWeight * clampedSeverity);
  }

  /** Returns the score after folding in a quality scorer result in [0, 1]. */
  public recordQuality(currentScore: number, qualityScore: number): number {
    const clampedQ = Math.max(0, Math.min(1, qualityScore));
    const delta = (clampedQ - 1) * this.qualityWeight * currentScore;
    return clamp(currentScore + delta);
  }
}

function clamp(score: number): number {
  if (score < 0) return 0;
  if (score > 100) return 100;
  return score;
}
