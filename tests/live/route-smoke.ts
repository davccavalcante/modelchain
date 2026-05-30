/**
 * Live integration smoke test.
 *
 * Routes a single prompt through Gemini (only provider key available in the
 * shared NPMJS/.env). NEVER logs raw API key. NEVER logs the full response
 * (only the first 80 chars).
 *
 * Run:
 *   pnpm dlx tsx --env-file=../.env tests/live/route-smoke.ts
 */
import { createModelchain } from '../../src/index.js';
import { geminiModel } from '../../src/providers/gemini.js';
import type { TelemetryEvent } from '../../src/types.js';

const GEMINI_KEY = process.env.GEMINI_API_KEY ?? '';
if (!GEMINI_KEY) {
  process.stderr.write('GEMINI_API_KEY is not set. Aborting live smoke test.\n');
  process.exit(2);
}

async function main(): Promise<void> {
  const router = createModelchain({
    models: [
      geminiModel('gemini-2.0-flash', {
        cost: { costPer1kInput: 0.0001, costPer1kOutput: 0.0004 },
        keys: GEMINI_KEY,
      }),
    ],
    strategy: 'cost-then-quality',
    scoring: { built: ['latency', 'length-bound'] },
    budget: { perRequestUsd: 0.01, dailyUsd: 1 },
    telemetry: { enabled: true },
  });

  const seenEvents: TelemetryEvent['type'][] = [];
  router.on((event) => {
    seenEvents.push(event.type);
    if (event.type === 'model.selected') {
      process.stdout.write(`> model.selected: id=${event.modelId} reason=${event.reason}\n`);
    } else if (event.type === 'request.success') {
      process.stdout.write(
        `> request.success: id=${event.modelId} latencyMs=${event.latencyMs} costUsd=${event.costUsd.toFixed(6)} usage=${JSON.stringify(event.usage)} finishReason=${event.finishReason} toolCallCount=${event.toolCallCount}\n`,
      );
    } else if (event.type === 'request.fail') {
      process.stdout.write(
        `> request.fail: id=${event.modelId} classification=${event.classification} status=${event.status ?? 'n/a'}\n`,
      );
    }
  });

  process.stdout.write('Sending one prompt to the live Gemini API ...\n');
  const t0 = Date.now();
  const response = await router.complete({
    prompt: 'In one short sentence, what is HTTP?',
    task: 'definition',
    maxTokens: 80,
  });
  const wallMs = Date.now() - t0;

  // SECURITY: only print the first 80 chars of the response.
  const preview = response.text.length > 80 ? `${response.text.slice(0, 80)}...` : response.text;

  process.stdout.write('\n--- result ---\n');
  process.stdout.write(`modelId       : ${response.modelId}\n`);
  process.stdout.write(`providerName  : ${response.providerName}\n`);
  process.stdout.write(`finishReason  : ${response.finishReason}\n`);
  process.stdout.write(`latencyMs     : ${response.latencyMs}\n`);
  process.stdout.write(`wallMs        : ${wallMs}\n`);
  process.stdout.write(`inputTokens   : ${response.usage.inputTokens}\n`);
  process.stdout.write(`outputTokens  : ${response.usage.outputTokens}\n`);
  process.stdout.write(`toolCalls     : ${response.toolCalls.length}\n`);
  process.stdout.write(`response (80) : ${preview}\n`);

  await new Promise<void>((resolve) => setTimeout(resolve, 50));

  process.stdout.write('\n--- telemetry event types observed ---\n');
  process.stdout.write(`${seenEvents.join(', ')}\n`);

  let ok = true;
  if (response.text.length === 0 && response.toolCalls.length === 0) {
    process.stderr.write('FAIL: response.text was empty and no tool calls.\n');
    ok = false;
  }
  if (!seenEvents.includes('request.success')) {
    process.stderr.write('FAIL: no request.success event emitted.\n');
    ok = false;
  }

  await router.close();
  if (!ok) process.exit(1);
  process.stdout.write('\n*** LIVE SMOKE OK ***\n');
}

main().catch((err: unknown) => {
  process.stderr.write(
    `\nLIVE SMOKE FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
