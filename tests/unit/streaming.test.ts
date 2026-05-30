import { describe, expect, it } from 'vitest';
import { anthropicStream } from '../../src/streaming/normalizers/anthropic.js';
import { geminiStream } from '../../src/streaming/normalizers/gemini.js';
import { openAIStream } from '../../src/streaming/normalizers/openai.js';
import { readSse } from '../../src/streaming/reader.js';
import type { CompletionChunk } from '../../src/types.js';

function bodyFromString(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('readSse', () => {
  it('yields data payload between blank lines', async () => {
    const events = await collect(readSse(bodyFromString('data: hello\n\ndata: world\n\n')));
    expect(events).toEqual(['hello', 'world']);
  });

  it('joins multiple data lines per event with newline', async () => {
    const events = await collect(readSse(bodyFromString('data: a\ndata: b\n\n')));
    expect(events).toEqual(['a\nb']);
  });

  it('ignores comments', async () => {
    const events = await collect(readSse(bodyFromString(': keep-alive\n\ndata: x\n\n')));
    expect(events).toEqual(['x']);
  });

  it('flushes trailing event without final blank line', async () => {
    const events = await collect(readSse(bodyFromString('data: last\n')));
    expect(events).toEqual(['last']);
  });
});

describe('openAIStream', () => {
  it('yields text-delta chunks and a finish', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n' +
      'data: [DONE]\n\n';
    const chunks = (await collect(openAIStream(bodyFromString(sse)))) as CompletionChunk[];
    expect(chunks.filter((c) => c.type === 'text-delta')).toHaveLength(2);
    const finish = chunks.at(-1);
    expect(finish?.type).toBe('finish');
    if (finish?.type === 'finish') {
      expect(finish.finishReason).toBe('stop');
      expect(finish.usage?.totalTokens).toBe(3);
    }
  });

  it('emits tool-call-delta when delta has tool_calls', async () => {
    const sse =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Tokyo\\"}"}}]}}]}\n\n' +
      'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n' +
      'data: [DONE]\n\n';
    const chunks = (await collect(openAIStream(bodyFromString(sse)))) as CompletionChunk[];
    const tc = chunks.find((c) => c.type === 'tool-call-delta');
    expect(tc).toBeDefined();
    const finish = chunks.at(-1);
    if (finish?.type === 'finish') {
      expect(finish.finishReason).toBe('tool-calls');
    }
  });
});

describe('anthropicStream', () => {
  it('yields text deltas from content_block_delta events', async () => {
    const sse =
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}\n\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
      'data: {"type":"content_block_stop","index":0}\n\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n' +
      'data: {"type":"message_stop"}\n\n';
    const chunks = (await collect(anthropicStream(bodyFromString(sse)))) as CompletionChunk[];
    expect(chunks.some((c) => c.type === 'text-delta' && c.delta === 'hi')).toBe(true);
    const finish = chunks.at(-1);
    if (finish?.type === 'finish') {
      expect(finish.finishReason).toBe('stop');
      expect(finish.usage?.totalTokens).toBe(8);
    }
  });

  it('yields tool-call-delta from tool_use content blocks', async () => {
    const sse =
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}\n\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather"}}\n\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Tokyo\\"}"}}\n\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n' +
      'data: {"type":"message_stop"}\n\n';
    const chunks = (await collect(anthropicStream(bodyFromString(sse)))) as CompletionChunk[];
    const toolDeltas = chunks.filter((c) => c.type === 'tool-call-delta');
    expect(toolDeltas.length).toBeGreaterThanOrEqual(1);
    const finish = chunks.at(-1);
    if (finish?.type === 'finish') {
      expect(finish.finishReason).toBe('tool-calls');
    }
  });
});

describe('geminiStream', () => {
  it('yields text-delta and finish from streaming JSON objects', async () => {
    const arr = [
      {
        candidates: [
          {
            content: { parts: [{ text: 'hello' }] },
          },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
      },
      {
        candidates: [
          {
            content: { parts: [{ text: ' world' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      },
    ];
    // Gemini stream is a JSON array; we provide it as concatenated objects.
    const body = bodyFromString(arr.map((o) => JSON.stringify(o)).join(','));
    const chunks = (await collect(geminiStream(body))) as CompletionChunk[];
    const texts = chunks.filter((c) => c.type === 'text-delta');
    expect(texts.length).toBe(2);
    const finish = chunks.at(-1);
    if (finish?.type === 'finish') {
      expect(finish.finishReason).toBe('stop');
      expect(finish.usage?.totalTokens).toBe(5);
    }
  });

  it('emits tool-call-delta for functionCall parts', async () => {
    const body = bodyFromString(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'get_weather', args: { city: 'Tokyo' } } }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
      }),
    );
    const chunks = (await collect(geminiStream(body))) as CompletionChunk[];
    const tc = chunks.find((c) => c.type === 'tool-call-delta');
    expect(tc).toBeDefined();
  });
});
