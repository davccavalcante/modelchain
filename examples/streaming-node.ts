/**
 * Streaming example - consume the AsyncIterable<CompletionChunk> returned by
 * router.stream({...}).
 *
 * Run:
 *   pnpm dlx tsx examples/streaming-node.ts
 */
import { createModelchain } from '../src/index.js';
import { openaiModel } from '../src/providers/index.js';

async function main(): Promise<void> {
  const router = createModelchain({
    models: [
      openaiModel('gpt-4o-mini', {
        cost: { costPer1kInput: 0.00015, costPer1kOutput: 0.00060 },
        keys: process.env.OPENAI_API_KEY ?? '',
      }),
    ],
    telemetry: { enabled: true },
  });

  process.stdout.write('Streaming response:\n\n');
  let textTotal = '';
  for await (const chunk of router.stream({
    prompt: 'Write a 4-sentence story about a curious robot.',
    maxTokens: 200,
  })) {
    if (chunk.type === 'text-delta') {
      textTotal += chunk.delta;
      process.stdout.write(chunk.delta);
    } else if (chunk.type === 'tool-call-delta') {
      process.stdout.write(`\n[tool-call-delta: ${JSON.stringify(chunk.toolCall)}]\n`);
    } else if (chunk.type === 'finish') {
      process.stdout.write(`\n\n--- finish ---\nreason: ${chunk.finishReason}\n`);
      if (chunk.usage) process.stdout.write(`usage: ${JSON.stringify(chunk.usage)}\n`);
    }
  }
  process.stdout.write(`\ntotal text length: ${textTotal.length}\n`);
  await router.close();
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
