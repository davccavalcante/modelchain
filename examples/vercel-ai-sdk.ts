/**
 * Vercel AI SDK adapter - use modelchain as a LanguageModelV2 inside any
 * Vercel AI SDK consumer (generateText, streamText, generateObject, etc.).
 *
 * Install:
 *   pnpm add @takk/modelchain ai @ai-sdk/provider
 *
 * Run:
 *   pnpm dlx tsx examples/vercel-ai-sdk.ts
 */
import { generateText, streamText } from 'ai';
import { toVercelAILanguageModel } from '../src/ai-sdk/index.js';
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
  });

  const model = toVercelAILanguageModel(router);

  // Non-streaming via Vercel AI SDK
  // biome-ignore lint/suspicious/noExplicitAny: structural compat
  const { text } = await generateText({ model: model as any, prompt: 'Hi.' });
  process.stdout.write(`generateText: ${text}\n`);

  // Streaming via Vercel AI SDK
  // biome-ignore lint/suspicious/noExplicitAny: structural compat
  const stream = streamText({ model: model as any, prompt: 'Tell a short joke.' });
  process.stdout.write('streamText: ');
  for await (const delta of stream.textStream) {
    process.stdout.write(delta);
  }
  process.stdout.write('\n');

  await router.close();
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
