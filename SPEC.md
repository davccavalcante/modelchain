# @takk/modelchain - Technical Specification

**Version:** 1.0.0
**Status:** Stable
**License:** Apache-2.0

This document is the binding contract between `@takk/modelchain` and its consumers. Behavior described here is covered by SemVer: breaking changes require a major version bump and a deprecation cycle (see [SEMVER POLICY](#52-semver-policy)).

---

## 1. Purpose

`modelchain` is a universal, zero-runtime-dependency library and CLI that sits between a TypeScript/JavaScript application and any number of LLM providers, transparently:

- **Routing** one prompt across a pool of models by cost, latency, and observed quality.
- **Measuring** response quality through pluggable scorers and feeding the result back into the next routing decision.
- **Streaming** tokens as an `AsyncIterable<CompletionChunk>`, normalised across providers.
- **Tool calling** with a normalised `ToolDefinition[]` input and `ToolCall[]` output across providers.
- **Enforcing** cost ceilings via per-request / per-task / daily budgets.
- **Failing over** to the next eligible model on transient failure, with a per-model circuit breaker and bounded retry.
- **Adapting** into the Vercel AI SDK via `toVercelAILanguageModel(router)`.

It is library-shaped, not service-shaped. There is no central server, no SaaS dependency, no SDK lock-in. It does NOT own embeddings, RAG, vector stores, memory primitives, document loaders, agent loops, prompt templates with variables, output parsers beyond `schema-valid`, vision/multimodal inputs, or key rotation.

---

## 2. Public surface

### 2.1 Entry points

The package ships six subpath exports. The five library entries carry separate `import` (ESM) and `require` (CJS) conditions with matching `.d.ts` / `.d.cts` files; `/cli` is ESM-only with a shebang:

| Subpath | Default | Use |
|---|---|---|
| `.` | `./dist/index.{js,cjs}` | Core: `createModelchain`, errors, strategies, scorers, state, types |
| `./providers` | `./dist/providers/index.{js,cjs}` | `openaiModel`, `anthropicModel`, `geminiModel`, `httpModel` |
| `./web` | `./dist/web/index.{js,cjs}` | Browser-safe subset (`browser` condition) |
| `./edge` | `./dist/edge/index.{js,cjs}` | Edge-runtime preset (`worker` condition) |
| `./ai-sdk` | `./dist/ai-sdk/index.{js,cjs}` | Vercel AI SDK adapter (`toVercelAILanguageModel`) |
| `./cli` | `./dist/cli/index.js` | Local proxy + bench (Node only) |
| `./package.json` | `./package.json` | Manifest access for tooling |

A `modelchain` binary is exposed via `package.json#bin -> ./dist/cli/index.js`.

### 2.2 Core API

#### `createModelchain(options: ModelchainOptions): ModelchainRouter`

Builds the full router — model registry, strategy, scoring, retry, circuit breaker, budget guard, telemetry, streaming pipeline, and tool-calling pipeline — and returns a `ModelchainRouter`. Throws synchronously on an empty model pool.

#### `ModelchainOptions`

```ts
interface ModelchainOptions {
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
```

#### `ModelchainRouter`

```ts
interface ModelchainRouter {
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  stream(request: CompletionRequest): AsyncIterable<CompletionChunk>;
  inspect(): RouterSnapshot;
  on(listener: TelemetryListener): () => void;
  close(): Promise<void>;
}
```

#### Request and response shapes

```ts
interface CompletionRequest {
  readonly prompt: string;
  readonly task?: TaskTag | string;
  readonly system?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stopSequences?: readonly string[];
  readonly tools?: readonly ToolDefinition[];
  readonly metadata?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

interface CompletionResponse {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: FinishReason;
  readonly usage: TokenUsage;
  readonly modelId: ModelId;
  readonly providerName: string;
  readonly latencyMs: number;
  readonly rawProviderResponse?: unknown;
}

type CompletionChunk =
  | { readonly type: 'text-delta'; readonly delta: string }
  | { readonly type: 'tool-call-delta'; readonly toolCall: PartialToolCall }
  | { readonly type: 'finish'; readonly finishReason: FinishReason; readonly usage?: TokenUsage };

type FinishReason = 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error';

interface ToolDefinition { name: string; description: string; parameters: {...}; }
interface ToolCall       { id: string; name: string; arguments: Readonly<Record<string, unknown>>; }
```

#### Key handling

```ts
type KeySource = string | (() => string) | (() => Promise<string>);
```

modelchain has no opinion about how keys are produced. Wrap rotation in a resolver function if you need it.

### 2.3 Error hierarchy

```
Error
 └─ ModelchainError            (base; carries `code: ModelchainErrorCode`)
     ├─ AllModelsExhaustedError (every eligible model failed terminally or was circuit-open)
     ├─ BudgetExceededError     (a per-request / per-task / daily ceiling would be breached)
     └─ ProviderError           (a single provider call failed; carries `classification` + optional `status`)
```

All carry native `Error.cause` where applicable. `error.code` and `error.classification` are stable; the exact wording of `error.message` is not.

### 2.4 Telemetry events

`TelemetryEvent` is a discriminated union on `type`. A listener registered via `on()` receives every event; the returned function unsubscribes.

| Event | Payload (beyond `timestamp`) |
|---|---|
| `request.start` | `{ task?, attempt }` |
| `model.selected` | `{ modelId, reason }` |
| `request.success` | `{ modelId, latencyMs, costUsd, usage, finishReason, toolCallCount }` |
| `request.fail` | `{ modelId, status?, classification, message }` |
| `stream.start` | `{ modelId }` |
| `stream.finish` | `{ modelId, latencyMs, costUsd, usage, finishReason, toolCallCount }` |
| `model.degraded` | `{ modelId, healthScore }` |
| `circuit.open` | `{ modelId, cooldownUntil }` |
| `circuit.half-open` | `{ modelId }` |
| `circuit.closed` | `{ modelId }` |
| `budget.exhausted` | `{ scope, limit, attempted }` |
| `score.recorded` | `{ modelId, scorer, score }` |
| `all.exhausted` | `{ reason }` |

No telemetry event ever contains an API key, a prompt, or a response body.

---

## 3. Architecture

```
+-----------------------------------------+
| Caller code                             |
| const router = createModelchain({...})  |
| await router.complete({ prompt })       |
+-------------------+---------------------+
                    |
                    v
+-----------------------------------------+
| Router                                  |
| - ModelRegistry    (pool state)         |
| - RoutingStrategy  (select)             |
| - BudgetGuard      (preflight/commit)   |
| - CircuitBreaker   (open/half/closed)   |
| - Retrier          (backoff)            |
| - HealthMonitor    (EWMA decay)         |
| - ScoringStrategy  (measure)            |
| - Telemetry        (event emitter)      |
| - StateBackend     (persist)            |
+-------------------+---------------------+
                    | per-model key resolve
                    v
+-----------------------------------------+
| ProviderAdapter                         |
| (openai | anthropic | gemini | http)    |
| complete() / stream() + tool translate  |
+-------------------+---------------------+
                    | Web Fetch / Web Streams
                    v
              Upstream REST API
```

Provider adapters use Web Fetch for HTTP and Web Streams for SSE. The streaming layer has provider-specific normalisers (`openai.ts`, `anthropic.ts`, `gemini.ts`, `http.ts`). The tools layer has provider-specific translators with the same fan-out.

### 3.1 Routing strategies

- `cost-then-quality` (default): cheapest model meeting a quality floor; cold-start models are explored first.
- `cost-first`: cheapest model by averaged input/output price.
- `quality-first`: best observed quality, falling back to health score on cold start.
- `latency-first`: lowest observed average latency; unseen models tried first.
- `weighted`: random pick proportional to `weight` (default `1`; negative weights clamp to `0`; all-zero falls back to first eligible).
- `round-robin`: cyclic across eligible models.
- `sequential-fallback`: preserve declaration order; first eligible wins.

A consumer-supplied `RoutingStrategy` implements `select(candidates, request)` returning a model id or `null`.

### 3.2 Scoring

Scorers run after every successful response, normalising their judgment to `[0, 1]` and feeding back into per-model quality state (`score.recorded` telemetry). Built-ins: `latency`, `token-budget`, `length-bound`, `regex-match`, `exact-match`, `schema-valid`. A consumer-supplied `ScoringStrategy` (LLM-as-judge, external eval service) plugs in via `scoring.custom`.

### 3.3 State backends

- `MemoryStateBackend`: in-process, default, ephemeral, multi-runtime safe.
- `FileStateBackend`: Node-only JSON persistence of an aggregated `StateSnapshot` (per-model metadata + `spentTodayUsd` + `day`). Not part of the universal core; excluded from `/web` and `/edge`.

A consumer-supplied `StateBackend` implements `load(): Promise<StateSnapshot | null>` and `save(snapshot): Promise<void>`.

### 3.4 Circuit breaker

State machine, per model: `closed -> open` after `threshold` consecutive failures (default `3`); `open -> half-open` once `cooldownMs` (default `30_000`) has elapsed at the next pick; `half-open -> closed` on the first success; `half-open -> open` on any failure. The router filters out models whose `cooldownUntil > now`, so an `open` model is automatically skipped during its cooldown window.

### 3.5 Retry policy

Exponential backoff (`baseMs * 2 ** attempt`), capped at `maxDelayMs` (default `30_000`), with optional full jitter. Bounded by `max` retries (default `3`, `baseMs` default `250`). If the upstream provides `Retry-After` (numeric seconds or HTTP-date), that value is used as the cooldown override. Failover across models is bounded by `fallback.maxAttempts` (default: the number of models in the pool).

### 3.6 Failover trigger set

Provider errors are classified by HTTP status: `408`/`425` -> `timeout`; `429` -> `rate-limited`; `401`/`403` -> `unauthorized`; other `4xx` -> `bad-request`; `5xx` -> `server-error`; no status -> `network`; otherwise `unknown`. Retry and failover trigger on `rate-limited`, `server-error`, `timeout`, and `network`. The classes `unauthorized` and `bad-request` are terminal — modelchain fails over to the next model immediately, or throws `AllModelsExhaustedError` when none remain. Anthropic's `529 Overloaded` falls in the `5xx` range and is therefore treated as transient.

### 3.7 Streaming

`router.stream()` returns an `AsyncIterable<CompletionChunk>` (`text-delta`, `tool-call-delta`, `finish`). The SSE reader is built on the Web Streams API (no `node:stream`). Provider-specific normalisers translate OpenAI deltas, Anthropic `content_block_delta` events, Gemini `streamGenerateContent` JSON chunks, and OpenAI-compatible HTTP into the single `CompletionChunk` union. The stream always ends with exactly one `finish` chunk carrying usage and `finishReason`.

### 3.8 Tool calling

`tools: ToolDefinition[]` on the request is translated to each provider's native shape (OpenAI `tools` with function entries, Anthropic `tools` with `input_schema`, Gemini `functionDeclarations`); the response (`tool_calls`, `tool_use` blocks, `functionCall` parts) is parsed back into a normalised `ToolCall[]`. Available on both `complete()` and `stream()`.

### 3.9 Vercel AI SDK adapter

`toVercelAILanguageModel(router)` returns a `LanguageModelV2`-compatible object, typed structurally with no compile-time dependency on `@ai-sdk/provider`. `doGenerate` and `doStream` emit the full V2 content/stream lifecycle (`stream-start`, `text-start/delta/end`, `tool-input-start/delta/end`, `tool-call`, `finish`), usable with `generateText`, `streamText`, and tool calling.

---

## 4. Operational SLOs

The library is small; the headline targets are runtime characteristics, not service SLOs.

| Target | Budget |
|---|---|
| Runtime dependencies (required) | 0 |
| Peer dependencies (optional, per opt-in feature) | 5, all optional |
| Core bundle (`dist/index.js`, brotli) | <= 22 KB (actual ~5.6 KB) |
| Providers bundle (brotli) | <= 18 KB (actual ~4.1 KB) |
| AI SDK adapter bundle (brotli) | <= 8 KB (actual ~1.2 KB) |
| Per-request orchestrator overhead (no retry path) | < 5 ms p95 on M-series Mac |
| Tarball size (full package) | <= 300 KB |
| Engines | Node >= 20.0.0 |

The numbers below are the v1.0.0 SLOs that `modelchain` commits to. They cover only the work `modelchain` does itself — provider HTTP latency and provider-side processing time are out of scope (modelchain reports them via `latencyMs`, but does not promise a budget for them).

### 4.1 In-process overhead budgets

| Operation | Budget (p95) | Measured by |
|---|---|---|
| `createModelchain(options)` cold start | <= 10 ms | unit |
| Strategy decision (`select()` over <= 10 models) | <= 1 ms | golden |
| Pre-flight (`BudgetGuard.preflight` + `CircuitBreaker.canCall`) | <= 0.5 ms | unit |
| Post-flight (`commit` + `HealthMonitor.record*` + telemetry emit) | <= 1 ms | unit |
| `router.inspect()` (snapshot build) | <= 1 ms | unit |
| Telemetry listener fan-out (10 listeners) | <= 0.5 ms | unit |
| SSE chunk normalisation (per chunk, OpenAI/Anthropic/Gemini) | <= 0.2 ms | unit |

### 4.2 End-to-end latency overhead

`router.complete()` and `router.stream()` add deterministic overhead on top of the provider HTTP round-trip:

- p50 overhead: <= 2 ms
- p95 overhead: <= 5 ms
- p99 overhead: <= 10 ms

Overhead is the wall-clock time spent inside `modelchain` excluding the `fetch()` call (`(response.latencyMs - provider_rt) <= budget`).

### 4.3 Resilience SLOs

| Behaviour | Promise |
|---|---|
| Circuit transitions to `open` after consecutive failures | Within 1 ms of the breaching `recordFailure` call |
| Circuit transitions back to `half-open` after `cooldownMs` | Within 5 ms of the next selection attempt past the cooldown |
| `signal.aborted` mid-stream | Stream halts within 1 chunk of the next provider yield; never deadlocks |
| Streamed `BudgetGuard.exceedsStreamLimit` | Caller MUST abort within 1 chunk of the breach being observed |

### 4.4 Cost-tracking SLOs

- `BudgetGuard` total error vs. ground-truth USD <= 1 % (driven by `estimateTokens` heuristic — provider-reported `usage` is preferred when available).
- Telemetry `request.success.costUsd` never lags real cost by more than one event.
- A budget breach never lets the request hit the provider HTTP (`BudgetExceededError` is thrown before `fetch`).

### 4.5 Observability SLOs

- Every successful `complete()` emits exactly one of: `request.success` or `stream.finish`.
- Every failed `complete()` emits exactly one `request.fail` per terminal classification path.
- No telemetry event ever contains an API key, a prompt, or a response body.
- `RouterSnapshot` is always internally consistent: `totalRequests + totalStreams >= totalFailures` per healthy run.

### 4.6 Golden-routing contract

The decisions in `tests/golden/routing.test.ts` are part of the v1.0.0 contract. A change to any of them is a routing-semantics change and triggers a major version bump (see [§5.2](#52-semver-policy)).

### 4.7 How SLOs are enforced

- Unit/integration suites in `tests/unit/` and `tests/integration/` cover the bounded behaviours.
- `tests/golden/routing.test.ts` is the SemVer guard for decision semantics.
- Latency budgets are validated under CI by `pnpm size` for bundle weight and by the test suite's wall-clock measurements for hot paths. End-to-end latency overhead under realistic load is the user's responsibility to measure with their own telemetry sink — `modelchain` exposes the timestamps and `latencyMs` fields needed to compute it.

These targets are the design intent and the basis for evaluating regressions.

---

## 5. Stability promise

### 5.1 What counts as the public API

For 1.0.0 onward, the public API is:

- Every name exported from `./dist/index.{js,cjs,d.ts}` and from each subpath export.
- Every type, interface, class shape, function signature, and discriminated-union variant reachable from those exports.
- The named-string unions `RoutingStrategyName`, `BuiltInScorerName`, `ModelchainErrorCode`, `ProviderErrorClass`, and `FinishReason`.
- The shape of `ModelchainOptions`, `CompletionRequest`, `CompletionResponse`, `CompletionChunk`, `TelemetryEvent`, `RouterSnapshot`, and `StateSnapshot`.
- The CLI flags and subcommands of `modelchain`.

Not part of the public API:

- Anything inside `src/` that is not re-exported from `src/index.ts` or a subpath entrypoint.
- Files whose name starts with `_` (e.g. `src/providers/_shared.ts`).
- The content-hashed `dist/types-XXX.d.ts` shared chunk filename.
- The exact wording of error messages (but `error.code` and `error.classification` are stable).
- The internal layout of the router's intermediate state.

### 5.2 SemVer policy

| Change | Bump |
|---|---|
| Bug fix, internal refactor, dependency-pin update, performance improvement, doc-only | patch (`1.0.0 -> 1.0.1`) |
| New strategy, new scorer, new provider factory, new optional field, new `TelemetryEvent` variant, new `ModelchainErrorCode` / `FinishReason` value | minor (`1.0.0 -> 1.1.0`) |
| Renaming/removing an export, signature change, a change to routing decision semantics affecting an unchanged consumer, `StateSnapshot` schema change, CLI flag removal | major (`1.0.0 -> 2.0.0`) |

### 5.3 Deprecation policy

Breaking a public API requires:

1. **Announce** the deprecation in a minor release of the current major: add `@deprecated` JSDoc on the export. Consumers must always have a non-deprecated path.
2. **Ship** the deprecated API for at least one further minor of the same major. A symbol marked `@deprecated` in 1.x continues to function for the rest of the 1.x line.
3. **Remove** only in the next major release, accompanied by a migration recipe.

Security-driven exceptions (e.g. removing a function that bypasses a safety check) ship in the next patch with a `### Security` CHANGELOG entry.

### 5.4 License, provenance, and release invariants

- License stays Apache-2.0 within a major. `NOTICE` is preserved verbatim in the tarball.
- Releases use a two-step GitHub Actions flow (`release.yml` -> `npm-publish.yml`).
- Every release is published with `--provenance` (SLSA attestation by GitHub Actions OIDC). Consumers can verify via `npm view @takk/modelchain@<version> --json | jq .dist.attestations`.
- `pnpm@10.34.1` is the package manager declared in `packageManager`.
- Linear history is enforced on `main`; no force pushes; no deletions.

---

## 6. Runtime expectations

- `modelchain` is a library; it does not call out to any service at import time.
- All telemetry handlers are invoked synchronously inside the emitter. Throwing in a handler is caught and ignored; a misbehaving subscriber cannot crash the router.
- Persistence through a `StateBackend` is the consumer's choice; persistence errors are the backend's concern and never corrupt the authoritative in-memory state.
- `AbortSignal` passed on a request is honored on both `complete()` and `stream()`, halting in-flight work promptly.

### 6.1 Compatibility

| Runtime | Status |
|---|---|
| Node >= 20 | Supported, CI Node 20 / 22 / 24 |
| Bun >= 1.1 | Supported |
| Deno >= 1.40 | Supported via `/edge` |
| Cloudflare Workers | Supported via `/edge` |
| Vercel Edge Functions | Supported via `/edge` |
| Browser (React 18+/19, Next.js 14+/15, Vue 3, Svelte 5, Solid) | Supported via `/web` (requires a key resolver) |
| Vercel AI SDK (`ai` >= 5) | Supported via `/ai-sdk` |

### 6.2 Security and privacy

See [SECURITY.md](./SECURITY.md) and [PRIVACY.md](./PRIVACY.md). In summary:

- API keys are never logged, never serialised, never sent in telemetry events.
- Prompts and responses are never logged in plain text by `modelchain` itself.
- The persisted `StateSnapshot` contains only aggregated metadata.
- The `/web` entry documents the key-resolver pattern instead of raw-string keys.
- All provider calls go directly to the official REST endpoints.

---

## 7. Test surface

- Unit tests for every routing strategy, scorer, core component, state backend, provider adapter (mocked fetch, tools + stream paths), the streaming normalisers, the tool translators, and the Vercel AI SDK adapter.
- A golden suite (`tests/golden/routing.test.ts`) that locks every strategy's decision as part of the SemVer contract.
- Integration tests for end-to-end routing, failover, streaming, tool calling, mid-stream abort, and budget exhaustion.
- A live smoke test against the Gemini REST API (never logs raw keys or full responses).

Coverage thresholds enforced via `vitest.config.ts`: `lines >= 75`, `functions >= 75`, `branches >= 55`, `statements >= 75`. Current run (1.0.0): 182 tests across 12 suites; `lines 76.04%, statements 75.37%, functions 79.90%, branches 59.77%`.

---

## 8. Non-goals (in 1.0)

- Embeddings, RAG, vector stores, memory primitives, document loaders, agent loops, prompt templates with variables, and output parsers beyond `schema-valid` (out of scope — separate domains).
- Image / audio multimodal inputs and vision-language model adapters (planned for 1.2).
- Distributed state (Redis / KV backends planned for 1.1; memory + file in 1.0).
- An OpenTelemetry exporter (the telemetry primitive is in place; exporter planned for 1.1).
- Dedicated per-provider adapters beyond the four shipped (Groq, Together, DeepSeek, OpenRouter, Mistral, Fireworks are covered today by `httpModel(...)`; planned for 1.1).
- Key rotation (wrap your rotator in a key-resolver function).

See [TASK.md](./TASK.md) for the live deferred-work list.
