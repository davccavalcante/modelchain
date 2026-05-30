/**
 * CLI/TUI consumer - pattern for embedding modelchain inside Hermes Agent,
 * Claude Code, Gemini CLI, or any custom agent runtime.
 *
 * The agent runtime stays in charge of its loop, tool calls, and UX;
 * modelchain handles "which model do I send THIS prompt to".
 *
 * Run:
 *   pnpm dlx tsx examples/hermes-agent-style.ts "Explain MCP in one paragraph."
 */
import { createModelchain } from '../src/index.js';
import { anthropicModel, openaiModel } from '../src/providers/index.js';

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(' ') || 'Tell me a one-line fun fact.';

  const router = createModelchain({
    models: [
      openaiModel('gpt-4o-mini', {
        cost: { costPer1kInput: 0.00015, costPer1kOutput: 0.00060 },
        keys: process.env.OPENAI_API_KEY ?? '',
        capabilities: ['general', 'reasoning'],
      }),
      anthropicModel('claude-3-5-sonnet-latest', {
        cost: { costPer1kInput: 0.00300, costPer1kOutput: 0.01500 },
        keys: process.env.ANTHROPIC_API_KEY ?? '',
        capabilities: ['general', 'reasoning', 'analysis'],
      }),
    ],
    strategy: 'cost-then-quality',
    scoring: { built: ['length-bound'] },
    fallback: { onError: 'next', maxAttempts: 2 },
    telemetry: { enabled: true },
  });

  router.on((event) => {
    if (event.type === 'model.selected') {
      process.stderr.write(`> routing to ${event.modelId} (${event.reason})\n`);
    }
  });

  // Stream tokens to stdout for live TUI display
  for await (const chunk of router.stream({ prompt, task: 'agent-step', maxTokens: 250 })) {
    if (chunk.type === 'text-delta') process.stdout.write(chunk.delta);
    if (chunk.type === 'finish') process.stdout.write('\n');
  }
  await router.close();
}

main().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
