/**
 * Tool calling example - declare a tool and let the model decide whether to
 * invoke it. Modelchain normalises the response so the same code works
 * regardless of which provider was routed to.
 *
 * Run:
 *   pnpm dlx tsx examples/tool-calling.ts
 */
import { createModelchain } from '../src/index.js';
import { anthropicModel, openaiModel } from '../src/providers/index.js';
import type { ToolCall } from '../src/types.js';

async function main(): Promise<void> {
  const router = createModelchain({
    models: [
      openaiModel('gpt-4o-mini', {
        cost: { costPer1kInput: 0.00015, costPer1kOutput: 0.00060 },
        keys: process.env.OPENAI_API_KEY ?? '',
        capabilities: ['tool-calling'],
      }),
      anthropicModel('claude-3-5-haiku-latest', {
        cost: { costPer1kInput: 0.00080, costPer1kOutput: 0.00400 },
        keys: process.env.ANTHROPIC_API_KEY ?? '',
        capabilities: ['tool-calling'],
      }),
    ],
    strategy: 'cost-then-quality',
  });

  const response = await router.complete({
    prompt: 'What is the current weather in Tokyo? Use the tool if useful.',
    tools: [
      {
        name: 'get_weather',
        description: 'Get the current weather in a city.',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'City name' },
            unit: {
              type: 'string',
              description: 'Temperature unit',
              enum: ['celsius', 'fahrenheit'],
            },
          },
          required: ['city'],
        },
      },
    ],
    maxTokens: 200,
  });

  process.stdout.write(`finishReason: ${response.finishReason}\n`);
  process.stdout.write(`text: ${response.text}\n`);
  process.stdout.write(`toolCalls: ${JSON.stringify(response.toolCalls, null, 2)}\n`);

  if (response.toolCalls.length > 0) {
    process.stdout.write('\nExecuting tool calls (mock implementation):\n');
    for (const call of response.toolCalls) {
      const result = executeToolMock(call);
      process.stdout.write(`  ${call.name}(${JSON.stringify(call.arguments)}) -> ${result}\n`);
    }
  }

  await router.close();
}

function executeToolMock(call: ToolCall): string {
  if (call.name === 'get_weather') {
    return `It is 22 degrees and sunny in ${String(call.arguments.city ?? 'unknown')}.`;
  }
  return 'no implementation';
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
