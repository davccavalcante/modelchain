# Changelog

All notable changes to `@takk/modelchain` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Every entry carries a UTC timestamp.

## [1.0.0] - 2026-05-30T11:17:38Z

Initial stable release. Universal, zero-runtime-dependency NPM library and CLI for intelligent, measurable LLM routing across OpenAI, Anthropic, Gemini, and any OpenAI-compatible HTTP endpoint, with native streaming, native tool calling, and a Vercel AI SDK adapter.

### Added

#### Core router

- `createModelchain(options)` factory returning a `ModelchainRouter` (`complete`, `stream`, `inspect`, `on`, `close`) that wires the model registry, strategy, scoring, retry, circuit breaker, budget guard, telemetry, streaming pipeline, and tool-calling pipeline into one orchestrator.
- `ModelRegistry` holding per-model runtime state: health score, circuit state, in-flight count, average latency, observed quality, and cumulative cost.
- `CircuitBreaker` with `closed -> open -> half-open -> closed` state machine, per model, honoring a configurable failure threshold and cooldown.
- `Retrier` implementing exponential backoff with optional full jitter, bounded by attempt count and honoring `AbortSignal` during sleeps.
- `HealthMonitor` folding each success/failure into a per-model EWMA health score that drives degradation telemetry.
- `BudgetGuard` enforcing three independent cost ceilings: per-request, per-task, and daily (UTC rollover), checked both before (estimate) and after (commit) each call.
- `Telemetry` event emitter runtime-agnostic (no `node:events` dep). Thirteen event types: `request.start`, `model.selected`, `request.success`, `request.fail`, `stream.start`, `stream.finish`, `model.degraded`, `circuit.open`, `circuit.half-open`, `circuit.closed`, `budget.exhausted`, `score.recorded`, `all.exhausted`.
- `ModelchainError` base with `AllModelsExhaustedError`, `BudgetExceededError`, and `ProviderError` subclasses, all carrying the native `Error.cause` chain when applicable.

#### Routing strategies

- `cost-then-quality` (default): cheapest model meeting a quality floor, cold-start models explored first.
- `cost-first`: cheapest model by averaged input/output price.
- `quality-first`: best observed quality, falling back to health score on cold start.
- `latency-first`: lowest observed average latency, unseen models tried first.
- `weighted`: random pick proportional to declared `weight` (default 1, negative weights clamped to 0).
- `round-robin`: cyclic across eligible models.
- `sequential-fallback`: declaration-order preference, falls through on failure.
- Custom strategies plug into the `RoutingStrategy` interface.

#### Scoring

- Six built-in scorers: `latency`, `token-budget`, `length-bound`, `regex-match`, `exact-match`, `schema-valid`.
- Observed scores feed back into quality-aware routing and emit `score.recorded` telemetry.
- Custom scorers plug into the `ScoringStrategy` interface (LLM-as-judge, external eval services, etc.).

#### Provider adapters (subpath export)

- `@takk/modelchain/providers` exports `openaiModel`, `anthropicModel`, `geminiModel`, and `httpModel` (generic OpenAI-compatible REST factory with `buildRequest` / `parseResponse` / `parseStream` callbacks).
- All four implement `complete()` and `stream()` and translate tools both ways.
- Every adapter calls the official REST endpoint directly via Web Fetch - no vendor SDK is required at runtime.
- Shared `classifyStatus`, `estimateTokens`, and `parseRetryAfter` helpers in `src/providers/_shared.ts` (internal, not exported via package surface).

#### Streaming

- `router.stream({...})` returning `AsyncIterable<CompletionChunk>` with `text-delta`, `tool-call-delta`, and `finish` variants.
- Web Streams API SSE reader, multi-runtime safe (no `node:stream`).
- Four provider-specific normalisers: OpenAI deltas, Anthropic `content_block_delta`, Gemini `streamGenerateContent`, and OpenAI-compatible HTTP.

#### Tool calling

- Normalised `tools: ToolDefinition[]` request input and `toolCalls: ToolCall[]` response output across OpenAI / Anthropic / Gemini / any HTTP.
- Four translators converting between the modelchain shape and each provider's native shape (`tools`, `input_schema`, `functionDeclarations`).
- Available on both the `complete()` and `stream()` paths.

#### Vercel AI SDK adapter

- `@takk/modelchain/ai-sdk` exports `toVercelAILanguageModel(router)` returning a `LanguageModelV2`-compatible object.
- Structurally typed against the V2 contract - no compile-time dependency on `@ai-sdk/provider`.
- `doGenerate` and `doStream` emit the full V2 content/stream lifecycle (`stream-start`, `text-start/delta/end`, `tool-input-start/delta/end`, `tool-call`, `finish`); usable with `generateText`, `streamText`, and tool calling.

#### State backends

- `MemoryStateBackend` (default): in-process, zero overhead, multi-runtime safe.
- `FileStateBackend`: Node-only persistence of aggregated per-model metadata; not part of the universal core (excluded from `/web` and `/edge`).

#### CLI

- Binary `modelchain` exposed via `package.json#bin`.
- `modelchain start --port <n> --config <path>` boots a local Node proxy exposing `POST /complete`, `POST /stream`, and `GET /__modelchain_inspect`.
- `modelchain inspect --config <path>` prints a router snapshot.
- `modelchain bench --requests <n> --prompt <text>` runs a benchmark across the configured pool.
- `modelchain help` and `modelchain version`.
- Pure helper `parseArgs` extracted to `src/cli/args.ts` for unit testability.

#### Routing and failover defaults

- Provider errors classified into `rate-limited`, `unauthorized`, `bad-request`, `server-error`, `timeout`, `network`, and `unknown`, driving retry, failover, and circuit-breaker decisions.
- `Retry-After` (numeric seconds or HTTP-date) parsed via shared helper and used as the cooldown override.
- Automatic failover to the next eligible model when the selected one fails terminally; `AllModelsExhaustedError` raised only when the whole pool is exhausted.
- `AbortSignal` honored on both `complete()` and `stream()`, halting in-flight work promptly.

#### Distribution

- Dual ESM + CJS bundles for all five library entries (`./`, `/providers`, `/web`, `/edge`, `/ai-sdk`) built with tsup 8, target `node20`. ESM-only with shebang for `/cli`.
- Separate `.d.ts` and `.d.cts` type files per entrypoint.
- `exports` map with split `import`/`require` conditions per subpath, plus `browser` (web) and `worker` (edge) conditions.
- Zero required runtime dependencies. All provider SDKs and the Vercel AI SDK are optional peer dependencies.

### Quality

- 182 tests across 12 suites passing under Vitest 4.
- Coverage: lines 76.04%, statements 75.37%, functions 79.90%, branches 59.77%.
- Golden routing suite (`tests/golden/routing.test.ts`) locks every strategy's decision as part of the SemVer contract.
- Lint clean under Biome 2.4.16.
- Typecheck clean under TypeScript 6.0.3 in maximum-strict mode (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`).
- `publint` clean.
- `attw` clean for every entry point across all four resolution modes (node10, node16 CJS, node16 ESM, bundler).
- `size-limit` budgets met: core ESM 5.59 KB / CJS 5.78 KB (limit 22 KB), providers 4.13 KB (limit 18 KB), web ESM/CJS 5.59 / 5.78 KB (limit 28 KB), edge ESM/CJS 5.59 / 5.78 KB (limit 24 KB), ai-sdk 1.18 KB (limit 8 KB), all brotli.
- Live smoke test against the Gemini REST API executed end-to-end (error path verified; happy path requires a valid live key).

### Security

- Package is published with `--provenance` (SLSA attestation by GitHub Actions when released via the two-step `.github/workflows/release.yml` -> `.github/workflows/npm-publish.yml` flow). Consumers can verify via `npm view @takk/modelchain --json | jq .dist.attestations`.
- API keys are never logged, never serialised, and never sent in telemetry events.
- Prompts and responses are never logged in plain text by modelchain itself; the persisted state holds only aggregated metadata.
- The `/web` entry forces a key resolver function, refusing raw-string keys in the browser.

### Licensing

- Licensed under the Apache License, Version 2.0. `NOTICE` file ships in the tarball alongside `LICENSE`.

### Engines

- Node `>=20.0.0`. CI matrix on Node 20, 22, and 24.
- Multi-runtime: also runs on Bun, Deno, Cloudflare Workers, and Vercel Edge (via `/edge`), and in the browser (via `/web`).

## [Unreleased]

See [TASK.md](./TASK.md) for the live roadmap. Highlights queued for 1.1:

- `redis` / KV state backends.
- OpenTelemetry exporter for the telemetry bus.
- Dedicated provider adapters (Groq, Together, DeepSeek, OpenRouter, Mistral, Fireworks), today covered by `httpModel(...)`.
- `@takk/modelchain-pricing` community pricing registry.
