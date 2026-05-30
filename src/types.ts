/**
 * Public type surface of @takk/modelchain.
 *
 * Stability: every exported type here is part of the SemVer 2.0.0 stability
 * contract declared in SPEC.md. Anything not exported from `src/index.ts` is
 * internal and may change between patch releases.
 */

/** Opaque branded type for a model identifier inside the registry. */
export type ModelId = string & { readonly __brand: 'ModelId' };

/** Opaque branded type for a task tag (e.g. 'summarisation', 'reasoning'). */
export type TaskTag = string & { readonly __brand: 'TaskTag' };

/**
 * Key material accepted by a provider.
 *
 * - `string`              : raw API key (only safe server-side).
 * - `() => string`        : synchronous resolver.
 * - `() => Promise<string>`: async resolver (server-side secret manager, edge KV, etc.).
 *
 * Modelchain has no opinion about how a key is produced. To rotate, wrap your
 * rotation library in a resolver function.
 */
export type KeySource = string | (() => string) | (() => Promise<string>);

/** Cost metadata declared per model. Both fields are USD per 1 000 tokens. */
export interface CostProfile {
  readonly costPer1kInput: number;
  readonly costPer1kOutput: number;
}

/** Definition of a model in the registry. */
export interface ModelDefinition {
  readonly id: ModelId | string;
  readonly provider: ProviderAdapter;
  readonly cost: CostProfile;
  readonly estimatedLatencyP50Ms?: number;
  readonly capabilities?: readonly string[];
  readonly keys: KeySource;
  readonly weight?: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Normalised completion request handed to a provider adapter. */
export interface CompletionRequest {
  readonly prompt: string;
  readonly task?: TaskTag | string;
  readonly system?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stopSequences?: readonly string[];
  /**
   * Tool / function definitions the model may invoke.
   *
   * If present, the provider adapter translates these to the provider's native
   * shape, and any tool calls in the response are normalised back into
   * `CompletionResponse.toolCalls`.
   */
  readonly tools?: readonly ToolDefinition[];
  readonly metadata?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** Why a completion stopped. */
export type FinishReason = 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error';

/** Normalised completion response returned by a provider adapter. */
export interface CompletionResponse {
  /** Free-text content. May be empty when the response is entirely tool calls. */
  readonly text: string;
  /** Tool / function calls the model decided to invoke. Empty when none. */
  readonly toolCalls: readonly ToolCall[];
  /** Why the generation stopped. */
  readonly finishReason: FinishReason;
  readonly usage: TokenUsage;
  readonly modelId: ModelId;
  readonly providerName: string;
  readonly latencyMs: number;
  readonly rawProviderResponse?: unknown;
}

/** Token usage accounting per completion. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/** A single delta in a streaming response. */
export type CompletionChunk =
  | {
      readonly type: 'text-delta';
      readonly delta: string;
    }
  | {
      readonly type: 'tool-call-delta';
      readonly toolCall: PartialToolCall;
    }
  | {
      readonly type: 'finish';
      readonly finishReason: FinishReason;
      readonly usage?: TokenUsage;
    };

/** A tool call may arrive across multiple deltas; the index ties them together. */
export interface PartialToolCall {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly argumentsDelta?: string;
}

/** Tool / function definition exposed to the model. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, ToolParameter>>;
    readonly required?: readonly string[];
  };
}

/** Recursive parameter shape supporting the JSON Schema subset modelchain normalises. */
export interface ToolParameter {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly items?: ToolParameter;
  readonly properties?: Readonly<Record<string, ToolParameter>>;
  readonly required?: readonly string[];
}

/** A fully-formed tool call extracted from a provider response. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/**
 * Adapter contract a provider must implement to participate in routing.
 *
 * All adapters MUST be multi-runtime safe (no `node:*` imports) so the core
 * can run unchanged in Edge runtimes and the browser. Network calls use the
 * Web Fetch API (available in Node >=18, Bun, Deno, browsers, and all major
 * edge runtimes).
 */
export interface ProviderAdapter {
  readonly name: string;
  readonly complete: (
    request: CompletionRequest,
    context: ProviderCallContext,
  ) => Promise<CompletionResponse>;
  readonly stream: (
    request: CompletionRequest,
    context: ProviderCallContext,
  ) => AsyncIterable<CompletionChunk>;
  readonly parseError: (error: unknown) => ParsedProviderError;
}

/** Context passed by the router to a provider for one call. */
export interface ProviderCallContext {
  readonly model: ModelDefinition;
  readonly apiKey: string;
  readonly attemptNumber: number;
}

/** Normalised error description returned by `ProviderAdapter.parseError`. */
export interface ParsedProviderError {
  readonly status?: number;
  readonly classification: ProviderErrorClass;
  readonly retryAfterMs?: number;
  readonly message: string;
}

/**
 * Discriminated classes of provider errors used by the retrier and circuit
 * breaker to decide whether to fail over, retry, or surface the error.
 */
export type ProviderErrorClass =
  | 'rate-limited'
  | 'unauthorized'
  | 'bad-request'
  | 'server-error'
  | 'timeout'
  | 'network'
  | 'unknown';

/** Per-model snapshot returned by `router.inspect()`. */
export interface ModelSnapshot {
  readonly id: string;
  readonly providerName: string;
  readonly circuitState: 'closed' | 'half-open' | 'open';
  readonly healthScore: number;
  readonly inFlight: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly consecutiveFailures: number;
  readonly cooldownUntil: number;
  readonly lastUsedAt: number;
  readonly avgLatencyMs: number;
  readonly avgQualityScore: number | null;
  readonly totalCostUsd: number;
}

/** Snapshot of the whole router. */
export interface RouterSnapshot {
  readonly strategy: string;
  readonly totalRequests: number;
  readonly totalStreams: number;
  readonly totalFailures: number;
  readonly totalCostUsd: number;
  readonly budget: BudgetSnapshot;
  readonly models: readonly ModelSnapshot[];
}

/** Snapshot of the budget state. */
export interface BudgetSnapshot {
  readonly perRequestUsd: number | null;
  readonly perTaskUsd: Readonly<Record<string, number>>;
  readonly dailyUsd: number | null;
  readonly spentTodayUsd: number;
  readonly remainingTodayUsd: number | null;
}

/** Telemetry event payloads - discriminated union. */
export type TelemetryEvent =
  | {
      readonly type: 'request.start';
      readonly task?: string;
      readonly attempt: number;
      readonly timestamp: number;
    }
  | {
      readonly type: 'model.selected';
      readonly modelId: string;
      readonly reason: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'request.success';
      readonly modelId: string;
      readonly latencyMs: number;
      readonly costUsd: number;
      readonly usage: TokenUsage;
      readonly finishReason: FinishReason;
      readonly toolCallCount: number;
      readonly timestamp: number;
    }
  | {
      readonly type: 'request.fail';
      readonly modelId: string;
      readonly status?: number;
      readonly classification: ProviderErrorClass;
      readonly message: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'stream.start';
      readonly modelId: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'stream.finish';
      readonly modelId: string;
      readonly latencyMs: number;
      readonly costUsd: number;
      readonly usage: TokenUsage;
      readonly finishReason: FinishReason;
      readonly toolCallCount: number;
      readonly timestamp: number;
    }
  | {
      readonly type: 'model.degraded';
      readonly modelId: string;
      readonly healthScore: number;
      readonly timestamp: number;
    }
  | {
      readonly type: 'circuit.open';
      readonly modelId: string;
      readonly cooldownUntil: number;
      readonly timestamp: number;
    }
  | {
      readonly type: 'circuit.half-open';
      readonly modelId: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'circuit.closed';
      readonly modelId: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'budget.exhausted';
      readonly scope: 'per-request' | 'per-task' | 'daily';
      readonly limit: number;
      readonly attempted: number;
      readonly timestamp: number;
    }
  | {
      readonly type: 'score.recorded';
      readonly modelId: string;
      readonly scorer: string;
      readonly score: number;
      readonly timestamp: number;
    }
  | {
      readonly type: 'all.exhausted';
      readonly reason: string;
      readonly timestamp: number;
    };

/** Listener signature for telemetry subscriptions. */
export type TelemetryListener = (event: TelemetryEvent) => void;

/** Configuration for the retry layer. */
export interface RetryOptions {
  readonly max: number;
  readonly baseMs: number;
  readonly jitter: boolean;
  readonly maxDelayMs?: number;
}

/** Configuration for the per-model circuit breaker. */
export interface CircuitBreakerOptions {
  readonly threshold: number;
  readonly cooldownMs: number;
  readonly halfOpenAfterMs?: number;
}

/** Configuration for the budget guard. */
export interface BudgetOptions {
  readonly perRequestUsd?: number;
  readonly perTaskUsd?: Readonly<Record<string, number>>;
  readonly dailyUsd?: number;
}

/** Configuration for the failover policy. */
export interface FallbackOptions {
  readonly onError?: 'next' | 'fail';
  readonly maxAttempts?: number;
}

/** Top-level configuration handed to `createModelchain`. */
export interface ModelchainOptions {
  readonly models: readonly ModelDefinition[];
  readonly strategy?: RoutingStrategyName | RoutingStrategy;
  readonly scoring?: ScoringOptions;
  readonly retry?: RetryOptions;
  readonly circuitBreaker?: CircuitBreakerOptions;
  readonly budget?: BudgetOptions;
  readonly fallback?: FallbackOptions;
  readonly telemetry?: { enabled: boolean };
  readonly state?: StateBackend;
}

/** Name of a built-in routing strategy. */
export type RoutingStrategyName =
  | 'round-robin'
  | 'weighted'
  | 'cost-first'
  | 'quality-first'
  | 'cost-then-quality'
  | 'latency-first'
  | 'sequential-fallback';

/** Routing strategy contract. */
export interface RoutingStrategy {
  readonly name: string;
  readonly select: (
    candidates: readonly ModelSnapshot[],
    request: CompletionRequest,
  ) => string | null;
}

/** Scoring configuration. */
export interface ScoringOptions {
  readonly built?: readonly BuiltInScorerName[];
  readonly custom?: readonly ScoringStrategy[];
}

/** Name of a built-in scorer. */
export type BuiltInScorerName =
  | 'latency'
  | 'token-budget'
  | 'length-bound'
  | 'regex-match'
  | 'exact-match'
  | 'schema-valid';

/** Scoring strategy contract - pluggable, can call an external LLM-as-judge. */
export interface ScoringStrategy {
  readonly name: string;
  readonly score: (
    request: CompletionRequest,
    response: CompletionResponse,
  ) => Promise<ScoringResult> | ScoringResult;
}

/** Result of a single scorer evaluation. */
export interface ScoringResult {
  readonly scorer: string;
  /** Score in [0, 1]. */
  readonly score: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Persistent state backend contract - used to share state across processes. */
export interface StateBackend {
  readonly name: string;
  readonly load: () => Promise<StateSnapshot | null>;
  readonly save: (snapshot: StateSnapshot) => Promise<void>;
}

/** Shape of the persistable state - never contains raw keys or raw responses. */
export interface StateSnapshot {
  readonly models: Readonly<
    Record<
      string,
      {
        readonly healthScore: number;
        readonly avgLatencyMs: number;
        readonly avgQualityScore: number | null;
        readonly successCount: number;
        readonly failureCount: number;
        readonly consecutiveFailures: number;
        readonly cooldownUntil: number;
        readonly totalCostUsd: number;
      }
    >
  >;
  readonly spentTodayUsd: number;
  readonly day: string;
}

/** Public router instance returned by `createModelchain`. */
export interface ModelchainRouter {
  /** Execute one completion request through the router. */
  readonly complete: (request: CompletionRequest) => Promise<CompletionResponse>;
  /**
   * Stream one completion request through the router.
   *
   * Yields `text-delta`, `tool-call-delta`, and `finish` chunks. The stream
   * always ends with exactly one `finish` chunk carrying the usage and finish
   * reason; consumers can rely on this for budget reconciliation.
   */
  readonly stream: (request: CompletionRequest) => AsyncIterable<CompletionChunk>;
  /** Inspect current router + per-model state. */
  readonly inspect: () => RouterSnapshot;
  /** Subscribe to telemetry events. Returns an unsubscribe function. */
  readonly on: (listener: TelemetryListener) => () => void;
  /** Stop all background work and release resources. */
  readonly close: () => Promise<void>;
}
