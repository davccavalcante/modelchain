import type { BudgetSnapshot, ModelSnapshot, ProviderErrorClass } from './types.js';

/**
 * Base error class for all errors thrown by @takk/modelchain.
 *
 * Always thrown with a stable, machine-readable `code` so callers can match on
 * the failure mode without parsing messages. Supports the ES2022 `cause`
 * option chain for wrapped errors.
 */
export class ModelchainError extends Error {
  public readonly code: ModelchainErrorCode;

  public constructor(code: ModelchainErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ModelchainError';
    this.code = code;
  }
}

/** Stable error codes used in the public API. */
export type ModelchainErrorCode =
  | 'NO_MODELS_CONFIGURED'
  | 'ALL_MODELS_EXHAUSTED'
  | 'BUDGET_EXCEEDED'
  | 'INVALID_OPTIONS'
  | 'PROVIDER_ERROR'
  | 'STRATEGY_FAILED'
  | 'ABORTED';

/**
 * Thrown when no model in the pool can accept the next request - every model
 * is circuit-open, cooling down, or has been excluded by the active strategy.
 */
export class AllModelsExhaustedError extends ModelchainError {
  public readonly snapshots: readonly ModelSnapshot[];
  public readonly lastReason: string;

  public constructor(snapshots: readonly ModelSnapshot[], lastReason: string) {
    super('ALL_MODELS_EXHAUSTED', `All models exhausted. Last reason: ${lastReason}`);
    this.name = 'AllModelsExhaustedError';
    this.snapshots = snapshots;
    this.lastReason = lastReason;
  }
}

/**
 * Thrown when a request would breach a declared budget. The router never
 * silently truncates or downgrades - the caller chooses how to react.
 */
export class BudgetExceededError extends ModelchainError {
  public readonly scope: 'per-request' | 'per-task' | 'daily';
  public readonly limit: number;
  public readonly attempted: number;
  public readonly budget: BudgetSnapshot;

  public constructor(
    scope: 'per-request' | 'per-task' | 'daily',
    limit: number,
    attempted: number,
    budget: BudgetSnapshot,
  ) {
    super(
      'BUDGET_EXCEEDED',
      `Budget exceeded (${scope}): attempted $${attempted.toFixed(6)} > limit $${limit.toFixed(6)}`,
    );
    this.name = 'BudgetExceededError';
    this.scope = scope;
    this.limit = limit;
    this.attempted = attempted;
    this.budget = budget;
  }
}

/**
 * Wraps a provider-side failure with the normalised classification.
 * The original cause is attached via the standard `cause` chain.
 */
export class ProviderError extends ModelchainError {
  public readonly providerName: string;
  public readonly modelId: string;
  public readonly classification: ProviderErrorClass;
  public readonly status: number | undefined;

  public constructor(
    providerName: string,
    modelId: string,
    classification: ProviderErrorClass,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(
      'PROVIDER_ERROR',
      `[${providerName}:${modelId}] ${classification}: ${message}`,
      options?.cause !== undefined ? { cause: options.cause } : {},
    );
    this.name = 'ProviderError';
    this.providerName = providerName;
    this.modelId = modelId;
    this.classification = classification;
    this.status = options?.status;
  }
}
