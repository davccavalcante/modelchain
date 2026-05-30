/**
 * @takk/modelchain - Universal, drop-in, measurable LLM router.
 *
 * Universal core entry. Works in Node >=20, Edge runtimes (Cloudflare Workers,
 * Vercel Edge, Deno, Bun), and the browser when used via the `/web` entry.
 *
 * Other entry points:
 *   - `@takk/modelchain/providers` - provider factories
 *   - `@takk/modelchain/web` - browser-safe subset
 *   - `@takk/modelchain/edge` - edge runtime preset
 *   - `@takk/modelchain/ai-sdk` - Vercel AI SDK adapter
 *   - `@takk/modelchain/cli` - CLI binary
 */

// Public entry - the factory.
export { createModelchain } from './core/createModelchain.js';
export type { ModelchainErrorCode } from './errors.js';
// Errors - exported so consumers can `instanceof` match.
export {
  AllModelsExhaustedError,
  BudgetExceededError,
  ModelchainError,
  ProviderError,
} from './errors.js';
// Scorers - exported so consumers can build pipelines.
export {
  ExactMatchScorer,
  LatencyScorer,
  LengthBoundScorer,
  RegexMatchScorer,
  SchemaValidScorer,
  TokenBudgetScorer,
} from './scoring/index.js';
export type { SchemaValidShape } from './scoring/SchemaValid.js';
// State backends - file backend is Node-only and not re-exported from /web or /edge.
export { MemoryStateBackend } from './state/memory.js';
// Strategies - exported so consumers can compose custom strategies.
export {
  CostFirst,
  CostThenQuality,
  LatencyFirst,
  QualityFirst,
  RoundRobin,
  SequentialFallback,
  Weighted,
} from './strategies/index.js';

// Public types - the SemVer contract surface.
export type {
  BudgetOptions,
  BudgetSnapshot,
  BuiltInScorerName,
  CircuitBreakerOptions,
  CompletionChunk,
  CompletionRequest,
  CompletionResponse,
  CostProfile,
  FallbackOptions,
  FinishReason,
  KeySource,
  ModelchainOptions,
  ModelchainRouter,
  ModelDefinition,
  ModelId,
  ModelSnapshot,
  ParsedProviderError,
  PartialToolCall,
  ProviderAdapter,
  ProviderCallContext,
  ProviderErrorClass,
  RetryOptions,
  RouterSnapshot,
  RoutingStrategy,
  RoutingStrategyName,
  ScoringOptions,
  ScoringResult,
  ScoringStrategy,
  StateBackend,
  StateSnapshot,
  TaskTag,
  TelemetryEvent,
  TelemetryListener,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  ToolParameter,
} from './types.js';
