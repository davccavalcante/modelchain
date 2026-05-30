/**
 * Node example - route across OpenAI, Anthropic and Gemini using
 * cost-then-quality default strategy.
 *
 * Run:
 *   pnpm dlx tsx examples/node-basic.ts
 */
import { createModelchain } from '../src/index.js';
import {
  anthropicModel,
  geminiModel,
  openaiModel,
} from '../src/providers/index.js';

async function main(): Promise<void> {
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
    scoring: { built: ['latency', 'length-bound'] },
    budget: { perRequestUsd: 0.02, dailyUsd: 5 },
    telemetry: { enabled: true },
  });

  router.on((event) => {
    if (event.type === 'model.selected' || event.type === 'request.success') {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
  });

  const response = await router.complete({
    prompt: 'Summarise: TypeScript is a typed superset of JavaScript.',
    task: 'summarisation',
    maxTokens: 80,
  });

  process.stdout.write(`\n--- response ---\n${response.text}\n`);
  await router.close();
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
