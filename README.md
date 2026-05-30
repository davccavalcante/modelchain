# Modelchain NPM

[![status: stable](https://img.shields.io/badge/status-stable-brightgreen)](./CHANGELOG.md)
[![license](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](./LICENSE)
[![version](https://img.shields.io/badge/version-1.0.0-blue)](./CHANGELOG.md)
[![node](https://img.shields.io/badge/node-%E2%89%A520-success)]()
[![tests](https://img.shields.io/badge/tests-182%20passing-brightgreen)]()
[![coverage](https://img.shields.io/badge/coverage-76%25%20lines-brightgreen)]()
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-success)]()
[![bundle (core, gz)](https://img.shields.io/badge/bundle%20(core%2C%20gz)-5.6%20KB-success)]()

<p align="center">
  <img src="https://raw.githubusercontent.com/davccavalcante/modelchain/main/assets/modelchain.png" alt="Modelchain" width="500">
</p>

[![Star History Chart](https://api.star-history.com/svg?repos=davccavalcante/modelchain&type=timeline&legend=top-left)](https://www.star-history.com/#davccavalcante/modelchain&type=timeline&legend=top-left)

> Universal, drop-in, **measurable** LLM router. Native streaming. Native tool calling. Vercel AI SDK adapter. Routes prompts across OpenAI, Anthropic, Gemini and any OpenAI-compatible HTTP endpoint by cost, latency and observed quality. Zero runtime dependencies.

`@takk/modelchain` lives between your application and any number of LLM providers. You declare a pool of models with their cost, capabilities, and key resolvers; the router picks the best one for each request based on the strategy you choose, **streams tokens** as they arrive, **normalises tool calls** across providers, scores the response with pluggable scorers, and feeds the result back into the next routing decision.

The same package runs unchanged in **Node, Edge runtimes (Cloudflare Workers, Vercel Edge, Deno, Bun), and the browser (React, Next.js, Vue, Svelte, Solid)**. It can plug directly into the **Vercel AI SDK** via `toVercelAILanguageModel(router)`.

**Core promise:** zero required runtime dependencies, single-function setup, ergonomic TypeScript types, ESM + CJS dual distribution across six entry points, native streaming and tool calling, a Vercel AI SDK adapter, and SLSA provenance on every release.

---

## Why modelchain

| Pain point | What modelchain does |
|---|---|
| Manually choosing the right model per request | Declarative pool + 7 routing strategies (`cost-first`, `quality-first`, `cost-then-quality`, `latency-first`, `weighted`, `round-robin`, `sequential-fallback`) |
| Static rules that decay as providers ship new models | **Measures** every response with pluggable scorers and adapts |
| Re-implementing streaming for each provider | `router.stream({...})` returns a normalised `AsyncIterable<CompletionChunk>` for OpenAI / Anthropic / Gemini / any OpenAI-compatible HTTP |
| Tool / function calling shapes differ across providers | Normalised `tools: ToolDefinition[]` input + `toolCalls: ToolCall[]` output |
| Embedding cost-control logic in every call site | Declarative `budget: { perRequestUsd, perTaskUsd, dailyUsd }` with hard ceilings |
| Provider-specific error shapes | Normalised `ProviderErrorClass` (rate-limited, server-error, timeout, network, ...) |
| Single-runtime libraries that can't span Node + Edge + browser | Six entry points, each tree-shakeable, no `node:*` in the core |
| Heavy frameworks (LangChain et al.) just to pick a model | Drop-in: `createModelchain({ models: [...] }).complete({ prompt })` |
| Vendor lock-in to one framework's adapter ecosystem | `toVercelAILanguageModel(router)` slots straight into the Vercel AI SDK |

The mental model is **Prisma, not LangChain** — one thing, done excellently, with a tiny surface and a forward-compatible API.

---

## Install

```bash
pnpm add @takk/modelchain
# or: npm install @takk/modelchain
# or: yarn add @takk/modelchain
# or: bun add @takk/modelchain
```

Provider SDKs are **peer dependencies** — install only the ones you use. modelchain calls the public REST APIs directly via Web Fetch and does NOT import any SDK at runtime; the peers are there for richer types in your editor.

```bash
# All optional. The HTTP provider needs nothing.
pnpm add openai              # for openaiModel(...)
pnpm add @anthropic-ai/sdk   # types only
pnpm add @google/genai       # types only
pnpm add ai @ai-sdk/provider # for the Vercel AI SDK adapter (toVercelAILanguageModel)
```

The core has **zero runtime dependencies**.

---

## Quickstart — Node

```ts
import { createModelchain } from '@takk/modelchain';
import { anthropicModel, geminiModel, openaiModel } from '@takk/modelchain/providers';

const router = createModelchain({
  models: [
    openaiModel('gpt-4o-mini', {
      cost: { costPer1kInput: 0.00015, costPer1kOutput: 0.00060 },
      keys: process.env.OPENAI_API_KEY ?? '',
    }),
    anthropicModel('claude-3-5-haiku-latest', {
      cost: { costPer1kInput: 0.00080, costPer1kOutput: 0.00400 },
      keys: process.env.ANTHROPIC_API_KEY ?? '',
    }),
    geminiModel('gemini-2.0-flash', {
      cost: { costPer1kInput: 0.00010, costPer1kOutput: 0.00040 },
      keys: process.env.GEMINI_API_KEY ?? '',
    }),
  ],
  strategy: 'cost-then-quality',
  scoring: { built: ['latency', 'token-budget'] },
  budget: { perRequestUsd: 0.02, dailyUsd: 5 },
  telemetry: { enabled: true },
});

// Non-streaming completion
const response = await router.complete({ prompt: 'Summarise X in 3 bullets.', maxTokens: 200 });
console.log(response.text, response.finishReason, response.usage);
```

Set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GEMINI_API_KEY` in your environment. modelchain routes each request to the model your strategy selects, retries with backoff on transient failure, opens a per-model circuit on repeated failure, fails over to the next eligible model, and scores the response to inform the next decision.

---

## Streaming

```ts
for await (const chunk of router.stream({ prompt: 'Tell me a story.' })) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.delta);
  if (chunk.type === 'tool-call-delta') console.log('\nTool call:', chunk.toolCall);
  if (chunk.type === 'finish') console.log('\nDone:', chunk.finishReason, chunk.usage);
}
```

Each provider emits its own streaming format (OpenAI SSE deltas, Anthropic `content_block_delta` events, Gemini `streamGenerateContent` JSON chunks). modelchain normalises all three into a single `CompletionChunk` discriminated union. The stream always ends with exactly one `finish` chunk carrying the usage and `finishReason` — consumers can rely on this for budget reconciliation.

---

## Tool calling

```ts
const result = await router.complete({
  prompt: 'What is the weather in Tokyo?',
  tools: [
    {
      name: 'get_weather',
      description: 'Get the current weather in a city.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
      },
    },
  ],
});
// result.toolCalls -> [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Tokyo' } }]
// result.finishReason -> 'tool-calls'
```

modelchain translates `ToolDefinition[]` to each provider's native shape (OpenAI `tools` with function entries, Anthropic `tools` with `input_schema`, Gemini `functionDeclarations`) and parses the responses (`tool_calls`, `tool_use` blocks, `functionCall` parts) back into a normalised `ToolCall[]`.

---

## Vercel AI SDK adapter

```ts
import { generateText, streamText } from 'ai';
import { toVercelAILanguageModel } from '@takk/modelchain/ai-sdk';
import { createModelchain } from '@takk/modelchain';
import { openaiModel } from '@takk/modelchain/providers';

const router = createModelchain({
  models: [
    openaiModel('gpt-4o-mini', {
      cost: { costPer1kInput: 0.00015, costPer1kOutput: 0.00060 },
      keys: process.env.OPENAI_API_KEY ?? '',
    }),
  ],
});

const { text } = await generateText({
  model: toVercelAILanguageModel(router),
  prompt: 'Hello.',
});
```

The adapter implements the `LanguageModelV2` contract structurally — no compile-time dependency on `@ai-sdk/provider`. Works with `generateText`, `streamText`, and tool-using flows.

---

## Edge runtimes (Cloudflare Workers, Vercel Edge, Deno, Bun)

```ts
import { createModelchain } from '@takk/modelchain/edge';
import { openaiModel } from '@takk/modelchain/providers';

interface Env { OPENAI_API_KEY: string }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { prompt } = await req.json<{ prompt: string }>();
    const router = createModelchain({
      models: [
        openaiModel('gpt-4o-mini', {
          cost: { costPer1kInput: 0.00015, costPer1kOutput: 0.00060 },
          keys: env.OPENAI_API_KEY,
        }),
      ],
      strategy: 'cost-first',
      budget: { perRequestUsd: 0.005 },
    });
    const response = await router.complete({ prompt });
    return Response.json({ text: response.text });
  },
};
```

The `/edge` entry uses only the Web Fetch + Web Streams APIs — runs unchanged on every Web-standard runtime.

---

## React / Next.js / Vue (browser)

```tsx
'use client';
import { createModelchain } from '@takk/modelchain/web';
import { openaiModel } from '@takk/modelchain/providers';

// IMPORTANT: never embed a raw API key in client code.
// Pass a resolver that fetches a short-lived token from your server.
const router = createModelchain({
  models: [
    openaiModel('gpt-4o-mini', {
      cost: { costPer1kInput: 0.00015, costPer1kOutput: 0.00060 },
      keys: async () => {
        const r = await fetch('/api/short-lived-openai-token', { method: 'POST' });
        const { token } = await r.json();
        return token;
      },
    }),
  ],
  budget: { perRequestUsd: 0.01 },
});

const response = await router.complete({ prompt: 'Hi from React.' });
```

Full Next.js, Vue and Cloudflare Workers examples live in [`examples/`](./examples).

---

## Strategies

| Name | When to use |
|---|---|
| `cost-then-quality` (default) | Cheapest model that meets a configurable quality floor. Cold-start models are tried first to gather data. |
| `cost-first` | Cheapest available, ignoring quality. |
| `quality-first` | Highest observed quality, regardless of cost. |
| `latency-first` | Lowest observed p50 latency. Exploration-first. |
| `weighted` | Probability proportional to declared `weight` (canary rollouts). |
| `round-robin` | Even distribution. |
| `sequential-fallback` | Always the first available; pairs with a primary-then-fallback chain. |

Custom strategies plug into the `RoutingStrategy` interface; see [src/types.ts](./src/types.ts).

---

## Scorers

Scorers run after every successful response, normalising their judgment to `[0, 1]` and feeding back into per-model quality state.

| Built-in | Purpose |
|---|---|
| `latency` | Time-to-first-byte vs. a target ms |
| `token-budget` | Efficient use of `maxTokens` — flags truncation |
| `length-bound` | Character-length sanity check |
| `regex-match` | Structural check via regex |
| `exact-match` | Reference comparison via `request.metadata.expected` |
| `schema-valid` | Top-level JSON schema (required keys + primitive types) |

Plug an LLM-as-judge by implementing `ScoringStrategy` and passing it via `scoring.custom`.

---

## Providers

| Provider | Factory | Use when |
|---|---|---|
| OpenAI | `openaiModel(...)` | Drop-in for any OpenAI chat-completions endpoint. Also: Groq, Together, DeepSeek, OpenRouter, Fireworks, Mistral La Plateforme (same shape — pass `baseUrl`). |
| Anthropic | `anthropicModel(...)` | Claude family via the Messages API. Handles `529 Overloaded`. |
| Gemini | `geminiModel(...)` | Google Generative Language REST. |
| HTTP | `httpModel(...)` | Any other JSON endpoint via `buildRequest` + `parseResponse` callbacks. |

All providers call the REST API directly via Web Fetch — **no SDK runtime dependency**.

---

## CLI

`modelchain` also works as a local proxy if you don't want to embed in code:

```bash
# 1. Author a config:
cat > modelchain.config.js <<'EOF'
import { createModelchain } from '@takk/modelchain';
import { openaiModel } from '@takk/modelchain/providers';
export default function () {
  return createModelchain({
    models: [openaiModel('gpt-4o-mini', { cost: { costPer1kInput: 0.00015, costPer1kOutput: 0.0006 }, keys: process.env.OPENAI_API_KEY ?? '' })],
    strategy: 'cost-first',
  });
}
EOF

# 2. Run the proxy
npx @takk/modelchain start --port 8788

# 3. From another terminal:
curl -X POST http://localhost:8788/complete \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Hi in 5 words."}'

curl -X POST http://localhost:8788/stream \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Tell a 50-word story."}'

curl http://localhost:8788/__modelchain_inspect | jq

npx @takk/modelchain bench --requests 10 --prompt "Summarise: AI is text in, text out."
```

---

## Failover details

modelchain automatically retries with backoff and fails over to the next eligible model on the following error classes:

- `rate-limited` — HTTP `429 Too Many Requests` (respects `Retry-After`, both numeric seconds and HTTP-date).
- `server-error` — HTTP `500`, `502`, `503`, `504`, and any other `5xx` (including Anthropic's `529 Overloaded`).
- `timeout` — HTTP `408 Request Timeout` and `425 Too Early`.
- `network` — connection failures with no HTTP status (DNS, reset, abort, `fetch failed`).

Terminal classes are NOT retried; modelchain fails over to the next model immediately, or throws if none remain:

- `unauthorized` — HTTP `401` / `403`. The credential is wrong; retrying the same key is pointless.
- `bad-request` — HTTP `400` and other `4xx`. The request is malformed; retrying won't help.

A model that keeps failing trips its per-model circuit breaker (`closed -> open -> half-open -> closed`); while open, the router skips it. When every model is simultaneously cooling down or circuit-open, modelchain throws `AllModelsExhaustedError` with the full router snapshot attached. Catch it at the boundary of your app.

---

## Telemetry

```ts
router.on((event) => {
  switch (event.type) {
    case 'model.selected':     /* log routing decision */ break;
    case 'request.success':    /* metrics + cost accounting */ break;
    case 'request.fail':       /* alerting */ break;
    case 'stream.start':       /* track in-flight streams */ break;
    case 'stream.finish':      /* metrics + cost reconciliation */ break;
    case 'circuit.open':       /* alert */ break;
    case 'budget.exhausted':   /* alert */ break;
    case 'score.recorded':     /* dashboards */ break;
  }
});
```

modelchain does not depend on OpenTelemetry. Bring your own observability sink — the telemetry surface is an in-process event emitter you subscribe to yourself, and no event ever contains an API key, a prompt, or a response body.

---

## Router inspection

```ts
const snapshot = router.inspect();
// {
//   strategy: 'cost-then-quality',
//   totalRequests: 1284,
//   totalStreams: 96,
//   totalFailures: 3,
//   totalCostUsd: 0.428117,
//   budget: { perRequestUsd: 0.02, dailyUsd: 5, spentTodayUsd: 0.43, remainingTodayUsd: 4.57, ... },
//   models: [
//     { id: 'gpt-4o-mini', providerName: 'http',
//       circuitState: 'closed', healthScore: 0.98,
//       inFlight: 0, successCount: 642, failureCount: 1,
//       consecutiveFailures: 0, cooldownUntil: 0,
//       lastUsedAt: 1748449183210, avgLatencyMs: 612,
//       avgQualityScore: 0.86, totalCostUsd: 0.21 },
//     ...
//   ]
// }
```

The snapshot carries only aggregated operational metadata. The raw API key value is never included in a snapshot or in a telemetry event.

---

## Quality

- 182 tests across 12 suites, all passing under Vitest 4.
- Coverage: lines 76%, statements 75.4%, functions 79.9%, branches 59.8%.
- Golden routing suite locks every strategy's decision as part of the SemVer contract.
- Lint clean under Biome 2.
- `tsc --noEmit` clean under TypeScript 6 in maximum strict mode (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`).
- `publint` clean.
- `attw` clean for every entry point (all 6 entries × all 4 resolution modes: node10, node16 CJS, node16 ESM, bundler).
- Bundle: **5.6 KB** brotli-compressed core; **4.1 KB** providers; **1.2 KB** Vercel AI SDK adapter.
- Validated live against the Gemini REST API end-to-end (the routing, HTTP, normalisation, scoring, and error-classification pipeline runs front to back; the happy path requires a valid live key).
- Published with `--provenance` (SLSA attestation by GitHub Actions).

See [SPEC.md](./SPEC.md) for the formal specification, public surface, stability promise, and service-level objectives.

---

## Versioning and stability

`@takk/modelchain` follows [SemVer 2.0.0](https://semver.org/). The public surface is the union of every symbol re-exported from `src/index.ts`. See [SPEC.md](./SPEC.md) for the full stability contract.

---

## FAQ

**Why not just use LangChain?**
LangChain is a broad framework; modelchain is one thing — a measurable router — done excellently. There is no chain abstraction, no agent runtime, no document loaders to learn. You call `createModelchain({ models }).complete({ prompt })` and you are done. The mental model is Prisma, not LangChain.

**Why not a gateway like LiteLLM, Portkey, or Bifrost?**
Those are services you run as a sidecar or SaaS hop. modelchain is a library you `pnpm add` — embeddable in any Node/Bun/Deno/Edge/browser process, no extra container, no extra network hop, no vendor lock-in. If you want a proxy, run `modelchain` in CLI mode — same code path.

**Does this work in Cloudflare Workers / Vercel Edge / Bun / Deno / the browser?**
Yes. The core, `/edge`, and `/web` entries use only Web Fetch + Web Streams — no `node:*` built-ins. Provider adapters call the REST endpoints directly, so they run anywhere `fetch` exists.

**How does it differ from a static router?**
A static router applies fixed rules. modelchain **measures** every response with pluggable scorers and feeds the score back into the next routing decision, so the pool adapts as providers ship new models and as observed latency and quality drift.

**Where does the state live?**
By default, in-process memory, discarded on `router.close()`. For persistence, pass a `StateBackend` — the shipped `FileStateBackend` writes aggregated metadata to disk (Redis / KV backends are on the 1.1 roadmap). See [PRIVACY.md](./PRIVACY.md) for exactly what is persisted.

**Does it work with the Vercel AI SDK?**
Yes. `toVercelAILanguageModel(router)` returns a `LanguageModelV2`-compatible object usable with `generateText`, `streamText`, and tool calling.

---

## Contributing

See [.github/CONTRIBUTING.md](./.github/CONTRIBUTING.md) for the contributor guide. Substantive proposals open a GitHub Issue first; trivial fixes can go straight to a PR. All commits require DCO sign-off (`git commit -s`). Non-trivial contributions are governed by the [Contributor License Agreement](./CLA.md).

## Community & support

- **Issues & feature requests.** Open a GitHub issue at [`davccavalcante/modelchain/issues`](https://github.com/davccavalcante/modelchain/issues). For each report, include: the package version, a minimal reproduction, expected vs. actual behaviour, and (where relevant) the relevant telemetry events or the `router.inspect()` snapshot.
- **Security disclosures.** Do NOT open public issues for vulnerabilities. Follow the responsible-disclosure flow in [`SECURITY.md`](./SECURITY.md) — contact `davcavalcante@proton.me` (or `say@takk.ag`) with the `[SECURITY]` prefix.
- **Code of Conduct.** This project follows the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md). Participation in any modelchain space (issues, PRs, discussions) implies agreement.
- **Contributions.** All non-trivial contributions go through the [Contributor License Agreement](./CLA.md). Tests, lint, typecheck, and build must be green before review (`pnpm verify`).

---

## Author

Created by **David C Cavalcante** — [davcavalcante@proton.me](mailto:davcavalcante@proton.me) (preferred) · [say@takk.ag](mailto:say@takk.ag) (Takk relay) · [linkedin.com/in/hellodav](https://linkedin.com/in/hellodav) · [x.com/davccavalcante](https://x.com/davccavalcante) · [takk.ag](https://takk.ag/)

`modelchain` is part of a broader portfolio of NPM packages targeting AI-native infrastructure for 2026-2030, built at Takk Innovate Studio.

---

## Related research by the author

The architectural philosophy behind `modelchain` — separating routing, scoring, state, and provider adapters into composable, independently-governed layers — echoes the author's research frameworks:

- **MAIC (Massive Artificial Intelligence Consciousness)** — a systemic intelligence framework designed to coordinate, supervise, and govern large-scale artificial intelligence ecosystems, providing global context awareness, alignment, and orchestration across multiple models, agents, and decision layers.
- **HIM (Hybrid Intelligence Model)** — a hybrid intelligence layer that integrates artificial intelligence systems with human-defined logic, rules, heuristics, and strategic intent, interpreting objectives and structuring decision-making before and after model execution.
- **NHE (Non-Human Entity)** — a non-human cognitive entity with a defined functional identity and operational agency within an AI ecosystem, operating through coordinated intelligence layers while maintaining a non-anthropomorphic identity.

These frameworks are published independently of `modelchain` and are separate works:

- Research papers: [The Soul of the Machine](https://philarchive.org/rec/CRTTSO) · [Beyond Consciousness in LLMs](https://philarchive.org/rec/CRTBCI) · [The Cave of Silence](https://philarchive.org/rec/CRTTCO).
- PhilPapers profile: [David Cortes Cavalcante](https://philpeople.org/profiles/david-cortes-cavalcante).
- Hugging Face: [TeleologyHI](https://huggingface.co/TeleologyHI).
- GitHub: [davccavalcante](https://github.com/davccavalcante) · [Takk8IS](https://github.com/Takk8IS).

---

## Sponsors

Join the journey as the portfolio continues to ship AI-native infrastructure. Your support is the cornerstone of this work.

- Sponsor on GitHub: [github.com/sponsors/davccavalcante](https://github.com/sponsors/davccavalcante)
- USDT (TRC-20): `TS1vuhMAhFpbd7y68cu5ZtP9PsXVmZWmeh`

---

## Privacy

`modelchain` runs entirely inside your own process and infrastructure. It makes no outbound calls to the author, collects no telemetry, and ships no analytics. The only network traffic it produces is the request you ask it to make, against the upstream you configured. See [PRIVACY.md](./PRIVACY.md) for the full data-handling notice, including exactly what the optional `StateBackend` persists on disk.

---

## License

Licensed under the **Apache License 2.0**. See [LICENSE](./LICENSE) for the full text and [NOTICE](./NOTICE) for attribution and third-party component licenses. You may use, modify, and distribute the code under the terms of that license, including its patent grant and attribution requirements.
