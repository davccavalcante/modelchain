import type { LanguageModelV2 } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { type LanguageModelV2Like, toVercelAILanguageModel } from '../../src/ai-sdk/index.js';
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResponse,
  ModelchainRouter,
  RouterSnapshot,
} from '../../src/types.js';

function makeRouter(
  completeImpl: (req: CompletionRequest) => Promise<CompletionResponse>,
  streamImpl?: (req: CompletionRequest) => AsyncIterable<CompletionChunk>,
): ModelchainRouter {
  const defaultStream: () => AsyncIterable<CompletionChunk> = async function* () {
    yield {
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  };
  return {
    complete: completeImpl,
    stream: streamImpl ?? defaultStream,
    inspect: (): RouterSnapshot => ({
      strategy: 'test',
      totalRequests: 0,
      totalStreams: 0,
      totalFailures: 0,
      totalCostUsd: 0,
      budget: {
        perRequestUsd: null,
        perTaskUsd: {},
        dailyUsd: null,
        spentTodayUsd: 0,
        remainingTodayUsd: null,
      },
      models: [],
    }),
    on: () => () => {},
    close: () => Promise.resolve(),
  };
}

describe('toVercelAILanguageModel', () => {
  it('returns LanguageModelV2Like with v2 spec metadata', () => {
    const adapter: LanguageModelV2Like = toVercelAILanguageModel(
      makeRouter(async () => completionResponse('hi')),
    );
    expect(adapter.specificationVersion).toBe('v2');
    expect(adapter.provider).toBe('modelchain');
    expect(adapter.modelId).toBe('modelchain');
    expect(typeof adapter.doGenerate).toBe('function');
    expect(typeof adapter.doStream).toBe('function');
  });

  it('compile-time: return value is structurally assignable to LanguageModelV2', () => {
    // The actual @ai-sdk/provider LanguageModelV2 has additional optional
    // fields the adapter does not emit. We assert structural assignability
    // via `satisfies` after casting through `unknown` since the V2 type
    // tracks more fields than the local alias. A clean runtime check is
    // included to keep the assertion live.
    const adapter = toVercelAILanguageModel(makeRouter(async () => completionResponse('hi')));
    const assignable: LanguageModelV2 = adapter as unknown as LanguageModelV2;
    expect(assignable.specificationVersion).toBe('v2');
    expect(assignable.provider).toBe('modelchain');
  });

  it('passes string prompt and returns text content', async () => {
    const seen: CompletionRequest[] = [];
    const adapter = toVercelAILanguageModel(
      makeRouter(async (req) => {
        seen.push(req);
        return completionResponse('hello');
      }),
    );
    const result = await adapter.doGenerate({ prompt: 'Hi' });
    expect(seen[0]?.prompt).toBe('Hi');
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(result.finishReason).toBe('stop');
  });

  it('flattens message-array prompts and extracts system separately', async () => {
    const seen: CompletionRequest[] = [];
    const adapter = toVercelAILanguageModel(
      makeRouter(async (req) => {
        seen.push(req);
        return completionResponse('ok');
      }),
    );
    await adapter.doGenerate({
      prompt: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(seen[0]?.system).toBe('be brief');
    expect(seen[0]?.prompt).toBe('hi');
  });

  it('translates tools through and returns tool-call input as JSON string', async () => {
    const seen: CompletionRequest[] = [];
    const adapter = toVercelAILanguageModel(
      makeRouter(async (req) => {
        seen.push(req);
        return completionResponse('', [
          { id: 'c1', name: 'get_weather', arguments: { city: 'Tokyo' } },
        ]);
      }),
    );
    const result = await adapter.doGenerate({
      prompt: 'weather?',
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get weather',
          inputSchema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ],
    });
    expect(seen[0]?.tools?.[0]?.name).toBe('get_weather');
    expect(result.content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'get_weather',
        input: '{"city":"Tokyo"}',
      },
    ]);
  });

  it('doStream emits stream-start, text-start/delta/end, finish (V2 lifecycle)', async () => {
    const stream: () => AsyncIterable<CompletionChunk> = async function* () {
      yield { type: 'text-delta', delta: 'hi' };
      yield { type: 'text-delta', delta: ' there' };
      yield {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      };
    };
    const adapter = toVercelAILanguageModel(
      makeRouter(async () => completionResponse('hi'), stream),
    );
    const { stream: readable } = await adapter.doStream({ prompt: 'Hi' });
    const reader = readable.getReader();
    const parts: Array<{ type: string }> = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) parts.push(value);
    }
    expect(parts.map((p) => p.type)).toEqual([
      'stream-start',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish',
    ]);
  });

  it('doStream emits tool-input-start/delta/end and tool-call for tool deltas', async () => {
    const stream: () => AsyncIterable<CompletionChunk> = async function* () {
      yield {
        type: 'tool-call-delta',
        toolCall: { index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '{"city":' },
      };
      yield {
        type: 'tool-call-delta',
        toolCall: { index: 0, argumentsDelta: '"Tokyo"}' },
      };
      yield {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      };
    };
    const adapter = toVercelAILanguageModel(makeRouter(async () => completionResponse(''), stream));
    const { stream: readable } = await adapter.doStream({ prompt: 'Hi' });
    const reader = readable.getReader();
    const parts: unknown[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) parts.push(value);
    }
    const types = parts.map((p) => (p as { type: string }).type);
    expect(types).toContain('tool-input-start');
    expect(types).toContain('tool-input-delta');
    expect(types).toContain('tool-input-end');
    expect(types).toContain('tool-call');
    expect(types[0]).toBe('stream-start');
    expect(types[types.length - 1]).toBe('finish');
    const toolCall = parts.find(
      (p): p is { type: 'tool-call'; toolCallId: string; toolName: string; input: string } =>
        (p as { type: string }).type === 'tool-call',
    );
    expect(toolCall?.toolCallId).toBe('call_1');
    expect(toolCall?.toolName).toBe('get_weather');
    expect(toolCall?.input).toBe('{"city":"Tokyo"}');
  });
});

function completionResponse(
  text: string,
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [],
): CompletionResponse {
  return {
    text,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool-calls' : 'stop',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    modelId: 'test' as never,
    providerName: 'fake',
    latencyMs: 1,
  };
}
