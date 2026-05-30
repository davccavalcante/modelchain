# Privacy Notice — modelchain

This notice describes what data `@takk/modelchain` processes when you install
and run it. `modelchain` is an npm library and CLI that runs entirely inside
your own process and infrastructure. The author (David C Cavalcante) hosts no
service, sees no traffic, and collects no telemetry.

Last updated: **2026-05-30**.

---

## 1. What modelchain is, and isn't

`modelchain` is a library you install and run in your own environment. There is
**no modelchain cloud**, no account, no sign-up. The author does not host any
endpoint that your installation talks to. The only network traffic `modelchain`
produces is the request **you** ask it to make, against the upstream LLM API
**you** configured, using the credentials **you** supplied.

---

## 2. Data modelchain processes (in your process)

### 2.1 API keys (in memory)

You give each model an API key — or a key resolver function — via
`openaiModel({ keys })`, `anthropicModel({ keys })`, `geminiModel({ keys })`, or
`httpModel({ keys })` (typically read from your own environment variables).
modelchain holds the resolved key in process memory only for the duration of the
outbound request it authorises. Keys are **never** sent anywhere except to the
upstream you configured, and are **never** transmitted to the author. The raw key
value is never logged, never serialised, never written to disk, and never
included in a telemetry event or an `inspect()` snapshot.

When you use `@takk/modelchain/web` from a browser, do **not** pass a raw string
key — anyone with dev-tools open can read it. Pass a resolver
(`keys: async () => fetchSecret(...)`) that calls **your** server endpoint, which
mints a short-lived, per-user token.

### 2.2 Prompts, responses, streaming chunks, and tool calls (transient)

Prompt text, response text, streamed chunks (`text-delta`, `tool-call-delta`),
and tool-call arguments live in process memory only for the duration of one call
cycle. modelchain returns them to you and retains none of them after the call —
or, for streams, after the async iterator is consumed. modelchain never logs
prompt or response content in plain text. A telemetry listener you register
yourself can observe token-usage counts (integers, used for cost accounting) but
never receives prompt or response bodies.

### 2.3 Router state (in memory by default)

For each model, modelchain tracks operational metrics: health score, circuit
state, in-flight count, average latency, observed quality score in `[0, 1]`,
success/failure counts, consecutive-failure count, cooldown timestamp, and
cumulative cost in USD. With the default in-memory state this lives only in
process memory and is discarded on `router.close()` or process exit.

### 2.4 Persisted router state (only if you choose a `StateBackend`)

If you provide a `StateBackend` (the shipped `FileStateBackend(path)` writes JSON
to the path you specify), modelchain persists only an aggregated `StateSnapshot`:

- `models`, keyed by model id, each containing only `healthScore`,
  `avgLatencyMs`, `avgQualityScore`, `successCount`, `failureCount`,
  `consecutiveFailures`, `cooldownUntil`, and `totalCostUsd`.
- `spentTodayUsd` (a number).
- `day` (a UTC date string).

**No credential material on disk.** The raw API key value, the prompts, and the
responses are **never** written to the state file. The unit suite asserts the
serialised snapshot contains no `sk-` string, no `apiKey` field, and no `prompt`
field.

The state file is therefore not a secret in the credential sense, but it does
reveal operational metadata (how each model id performed, what it cost, and
whether it was cooled down). Treat it according to your own threat model; a
typical project simply adds it to `.gitignore`.

### 2.5 Upstream provider traffic

When modelchain dispatches a request through an adapter (OpenAI, Anthropic,
Gemini, or the generic HTTP adapter), the request body and headers traverse
**the upstream provider's** infrastructure. modelchain never sees that traffic
except as the response it returns to you. **Each provider has its own
data-handling policy** — you must read and comply with it independently:

| Provider | Data-handling policy |
|---|---|
| OpenAI | <https://openai.com/policies> |
| Anthropic | <https://www.anthropic.com/legal> |
| Google (Gemini) | <https://ai.google.dev/terms> |
| Any HTTP endpoint | The endpoint operator's own policy |

---

## 3. Data modelchain does NOT collect

- **No telemetry to the author.** modelchain makes zero outbound network calls to
  the author's infrastructure. The telemetry surface is an in-process event
  emitter you subscribe to yourself; nothing leaves your process unless you wire
  it to leave.
- **No analytics.** No usage statistics, no error reporting, no fingerprinting.
- **No third-party SDK that phones home.** modelchain has zero required runtime
  dependencies and calls every provider's REST endpoint directly via Web Fetch.
  The optional peer dependencies (`openai`, `@anthropic-ai/sdk`, `@google/genai`,
  `ai`, `@ai-sdk/provider`) are official SDKs used for types and for the
  consumer-level Vercel AI SDK adapter; audit them with `npm ls --all`.

---

## 4. GDPR + LGPD posture

`modelchain` itself processes credentials and operational counters, not end-user
personal data — the prompts and payloads you send through it are **your** data
under **your** control, and modelchain never persists them. If your application
sends personal data through an adapter, that flow is governed by your own privacy
program and the upstream provider's policy, not by modelchain. The consumer
remains the controller and processor of any personal data flowing through prompts
and responses.

For operators in scope of **GDPR** or **LGPD**:

- **Minimisation**: modelchain persists only aggregated operational metrics (only
  when a `StateBackend` is enabled). It never logs request or response bodies.
- **Right to erasure**: delete the state file to remove all persisted modelchain
  state.
- **Portability**: the `StateSnapshot` is plain JSON and portable by
  construction. Routing persistence through a compliant `StateBackend`
  (HIPAA-eligible, EU-resident, etc.) is the consumer's choice.

---

## 5. Security disclosure

See [`SECURITY.md`](./SECURITY.md) for vulnerability reports and the threat
model. The author can be reached at **davcavalcante@proton.me** (preferred) or
**say@takk.ag** (Takk relay) with the `[SECURITY]` prefix.

---

## 6. Children

`modelchain` is developer infrastructure with no user-facing surface and no
features directed at children. It is not intended for direct use by children
under 13.

---

## 7. Changes to this notice

This file is versioned in git alongside the code. Material changes are announced
in [`CHANGELOG.md`](./CHANGELOG.md) and in the next release notes on GitHub.

---

## 8. Contact

- General (author): **davcavalcante@proton.me**
- Takk relay: **say@takk.ag**
- LinkedIn: <https://linkedin.com/in/hellodav>
- Security: **davcavalcante@proton.me** (or **say@takk.ag**) with the
  `[SECURITY]` prefix (see [`SECURITY.md`](./SECURITY.md)).
