# Security Policy

`@takk/modelchain` is a stable (1.0.0) library for measurable LLM routing, with
native streaming, native tool calling, and a Vercel AI SDK adapter. We take
security reports seriously and aim to acknowledge each one within two business
days.

## Supported versions

Each published version follows strict SemVer (see [`SPEC.md`](./SPEC.md) §5 and
[`.github/RELEASING.md`](./.github/RELEASING.md)). Only the latest minor of the
current major receives security patches; an older major receives critical-CVE
fixes for 6 months after the next major lands.

| Package | Supported |
|---|---|
| `@takk/modelchain` | current `latest` dist-tag |

## Reporting a vulnerability

**Please do not file public GitHub issues for security problems.** Send reports
to **davcavalcante@proton.me** (preferred) or **say@takk.ag** (Takk relay),
with the subject line beginning `[SECURITY]`.

Include, at minimum:

- Affected version (`npm ls @takk/modelchain`).
- Reproduction steps or a minimal proof-of-concept.
- Impact assessment (what an attacker can achieve).
- Any suggested mitigation.

If your report involves a vulnerability in a third-party peer dependency, please
also link the upstream advisory (CVE, GHSA, etc.) so we can coordinate the
disclosure.

PGP / signed reports are welcome but not required. If you need an out-of-band
channel, ask in the first message and we will propose one.

## Response process

1. Acknowledgement within **2 business days**.
2. Triage and severity assignment within **7 days**.
3. Fix targeted for the next release; critical issues ship as an out-of-band
   patch on the affected minor.
4. Coordinated disclosure: the reporter is credited in the changelog and
   advisory unless they request anonymity.

## Threat model in scope

Findings in any of the following are in scope:

- **Credential handling.** Any path that leaks a raw API key into a telemetry
  event, a `router.inspect()` snapshot, a thrown error message, or a log line.
  (By design, modelchain never logs, serialises, or emits raw key material; this
  is unit-tested.)
- **State persistence.** Path traversal in the `FileStateBackend` write path; any
  way to make modelchain write outside the configured path. The state backend
  persists only aggregated per-model metadata — never the raw key value, a
  prompt, or a response (see [`PRIVACY.md`](./PRIVACY.md) §2.4). Any path that
  causes a raw key, prompt, or response to reach the state file is therefore in
  scope and treated as a vulnerability.
- **Routing, failover, circuit, and budget logic.** Any way to defeat the
  per-model circuit breaker, the retry budget, or the `BudgetGuard` so that a
  single failing model can cause unbounded retries, a cost spike, or a denial of
  service against the caller.
- **Streaming and tool calling.** Any way to make modelchain mishandle a stream
  so that budget is silently mis-committed, or any path where a malformed
  tool-call response corrupts the normalised `ToolCall[]` returned to the
  consumer. (Validating tool-call arguments against your
  `ToolDefinition.parameters` before execution remains the consumer's
  responsibility.)
- **Provider adapter injection.** Header or URL injection through the `httpModel`
  `authHeader` / `baseUrl` / `buildRequest` configuration that lets an attacker
  redirect requests or smuggle headers.
- **Supply chain.** Tarball contamination, compromised npm scope, or a published
  artifact whose provenance attestation does not match the source commit.

## Out of scope

- The security of the upstream provider APIs themselves (OpenAI, Anthropic,
  Google, or any HTTP endpoint you configure) and the quality or safety of their
  responses.
- The custody of your API keys before they reach modelchain (your environment,
  your secret manager) — that is the operator's responsibility.
- Prompt-content safety, jailbreak detection, and content moderation — use a
  content-safety layer before the prompt reaches modelchain.
- Authentication / authorisation of the user issuing requests through your
  application.
- Encrypted-at-rest secret storage — use your platform's KMS / Secret Manager.
- Denial of service via unbounded inputs against your own application; request
  sizing and upstream rate limiting remain the operator's responsibility.

## Supply-chain assurances

- **Zero required runtime dependencies.** The attack surface from transitive
  dependencies is eliminated for the core and every provider adapter, which call
  the REST APIs directly via Web Fetch. Provider SDKs and the Vercel AI SDK are
  optional peer dependencies you install explicitly.
- **Provenance.** Every release is published with `npm publish --provenance`
  (SLSA attestation by GitHub Actions). Verify with
  `npm view @takk/modelchain@<version> --json | jq .dist.attestations`.
- **Lockfile committed.** `pnpm-lock.yaml` is tracked in git for reproducible
  installs; `pnpm audit` runs in CI and advisories block merges; dependency
  upgrades go through Dependabot + code review.

## Recommended consumer hardening

1. Use `@takk/modelchain/edge` instead of `/` for edge functions — no Node
   built-ins.
2. Use a key resolver (function) instead of raw string keys whenever the runtime
   supports fetching secrets.
3. Set `budget: { perRequestUsd, dailyUsd }` to bound cost from runaway loops.
4. Subscribe to `circuit.open` and `budget.exhausted` telemetry events and route
   them to alerting.
5. Pin `pnpm` to the version declared in `packageManager` (`pnpm@10.34.1`).
6. Verify SLSA provenance:
   ```bash
   npm view @takk/modelchain@1.0.0 --json | jq .dist.attestations
   ```
7. For tool calling: always validate tool-call arguments against your
   `ToolDefinition.parameters` before executing.

## Cryptographic primitives

`modelchain` does not perform cryptographic operations itself in v1.0.0. The
provider adapters rely on the platform's TLS stack via Web Fetch.
