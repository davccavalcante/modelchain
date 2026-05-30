import { BudgetExceededError } from '../errors.js';
import type {
  BudgetOptions,
  BudgetSnapshot,
  CompletionRequest,
  CostProfile,
  TokenUsage,
} from '../types.js';

/**
 * Cost ceiling enforcement.
 *
 * Three independent scopes:
 *   - per-request: hard ceiling for a single completion.
 *   - per-task   : hard ceiling per task tag (running total across the day).
 *   - daily      : hard ceiling across all calls today (UTC).
 *
 * The guard is consulted twice per request: BEFORE the call (`preflight`)
 * with an estimated cost, and AFTER the call (`commit`) with the actual
 * cost from the provider response.
 */
export class BudgetGuard {
  private readonly perRequestUsd: number | null;
  private readonly perTaskUsd: Readonly<Record<string, number>>;
  private readonly dailyUsd: number | null;

  private spentTodayUsd = 0;
  private spentPerTask: Record<string, number> = {};
  private currentDay: string;

  public constructor(options: BudgetOptions | undefined) {
    this.perRequestUsd = options?.perRequestUsd ?? null;
    this.perTaskUsd = Object.freeze({ ...(options?.perTaskUsd ?? {}) });
    this.dailyUsd = options?.dailyUsd ?? null;
    this.currentDay = utcDay(new Date());
  }

  /** Estimate cost from prompt length + maxTokens-or-512 output. */
  public estimate(request: CompletionRequest, cost: CostProfile): number {
    const promptChars = request.prompt.length + (request.system?.length ?? 0);
    const estInputTokens = Math.ceil(promptChars / 4);
    const estOutputTokens = request.maxTokens ?? 512;
    return (
      (estInputTokens / 1000) * cost.costPer1kInput +
      (estOutputTokens / 1000) * cost.costPer1kOutput
    );
  }

  /** Check against all three scopes BEFORE the call. Throws on breach. */
  /**
   * Check whether a streaming run has exceeded an absolute output-token
   * ceiling. Consumers wire this in their for-await loop to abort runaway
   * streams. Returns false when no `enforceStreamTokens` limit is configured.
   */
  public exceedsStreamLimit(
    accumulatedOutputTokens: number,
    enforceStreamTokens: number | undefined,
  ): boolean {
    return enforceStreamTokens !== undefined && accumulatedOutputTokens > enforceStreamTokens;
  }

  public preflight(request: CompletionRequest, estimatedCostUsd: number): void {
    this.rolloverIfNeeded();
    if (this.perRequestUsd !== null && estimatedCostUsd > this.perRequestUsd) {
      throw new BudgetExceededError(
        'per-request',
        this.perRequestUsd,
        estimatedCostUsd,
        this.snapshot(),
      );
    }
    if (this.dailyUsd !== null && this.spentTodayUsd + estimatedCostUsd > this.dailyUsd) {
      throw new BudgetExceededError(
        'daily',
        this.dailyUsd,
        this.spentTodayUsd + estimatedCostUsd,
        this.snapshot(),
      );
    }
    const taskTag = request.task;
    if (taskTag) {
      const taskLimit = this.perTaskUsd[taskTag];
      if (taskLimit !== undefined) {
        const taskSpent = this.spentPerTask[taskTag] ?? 0;
        if (taskSpent + estimatedCostUsd > taskLimit) {
          throw new BudgetExceededError(
            'per-task',
            taskLimit,
            taskSpent + estimatedCostUsd,
            this.snapshot(),
          );
        }
      }
    }
  }

  /** Commit the actual cost from a completed call. */
  public commit(request: CompletionRequest, cost: CostProfile, usage: TokenUsage): number {
    this.rolloverIfNeeded();
    const actualCost =
      (usage.inputTokens / 1000) * cost.costPer1kInput +
      (usage.outputTokens / 1000) * cost.costPer1kOutput;
    this.spentTodayUsd += actualCost;
    const taskTag = request.task;
    if (taskTag) {
      this.spentPerTask[taskTag] = (this.spentPerTask[taskTag] ?? 0) + actualCost;
    }
    return actualCost;
  }

  public snapshot(): BudgetSnapshot {
    this.rolloverIfNeeded();
    return {
      perRequestUsd: this.perRequestUsd,
      perTaskUsd: { ...this.spentPerTask },
      dailyUsd: this.dailyUsd,
      spentTodayUsd: this.spentTodayUsd,
      remainingTodayUsd:
        this.dailyUsd === null ? null : Math.max(0, this.dailyUsd - this.spentTodayUsd),
    };
  }

  /** Restore state from a snapshot (used by persistent state backends). */
  public restore(spentTodayUsd: number, day: string): void {
    if (day === utcDay(new Date())) {
      this.spentTodayUsd = spentTodayUsd;
      this.currentDay = day;
    }
  }

  public getSpentToday(): number {
    this.rolloverIfNeeded();
    return this.spentTodayUsd;
  }

  public getCurrentDay(): string {
    this.rolloverIfNeeded();
    return this.currentDay;
  }

  private rolloverIfNeeded(): void {
    const today = utcDay(new Date());
    if (today !== this.currentDay) {
      this.currentDay = today;
      this.spentTodayUsd = 0;
      this.spentPerTask = {};
    }
  }
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
