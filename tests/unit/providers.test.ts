import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../src/errors.js';
import {
  classifyStatus,
  estimateTokens,
  parseRetryAfter,
  resolveKey,
} from '../../src/providers/_shared.js';
import { anthropicModel } from '../../src/providers/anthropic.js';
import { geminiModel } from '../../src/providers/gemini.js';
import { httpModel } from '../../src/providers/http.js';
import { openaiModel } from '../../src/providers/openai.js';
import type { CompletionRequest, ProviderCallContext } from '../../src/types.js';

const okJson = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const errJson = (
  status: number,
  body: unknown = { error: { message: 'boom' } },
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

describe('_shared', () => {
  describe('classifyStatus', () => {
    it.each([
      [undefined, 'network'],
      [408, 'timeout'],
      [425, 'timeout'],
      [429, 'rate-limited'],
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [400, 'bad-request'],
      [500, 'server-error'],
      [504, 'server-error'],
      [200, 'unknown'],
    ] as const)('classifies %s -> %s', (status, expected) => {
      expect(classifyStatus(status)).toBe(expected);
    });
  });

  describe('parseRetryAfter', () => {
    it('parses delta-seconds', () => {
      expect(parseRetryAfter('5')).toBe(5000);
    });
    it('parses HTTP-date', () => {
      const future = new Date(Date.now() + 1000).toUTCString();
      expect(parseRetryAfter(future)).toBeGreaterThanOrEqual(0);
    });
    it('returns undefined on null / garbage', () => {
      expect(parseRetryAfter(null)).toBeUndefined();
      expect(parseRetryAfter('not-a-date-or-number-xyz')).toBeUndefined();
    });
  });

  describe('estimateTokens', () => {
    it('returns at least 1', () => {
      expect(estimateTokens('')).toBe(1);
    });
    it('scales roughly with length', () => {
      expect(estimateTokens('x'.repeat(40))).toBe(10);
    });
  });

  describe('resolveKey', () => {
    it('returns string key as-is', async () => {
      expect(await resolveKey('sk-direct')).toBe('sk-direct');
    });
    it('throws on empty string', async () => {
      await expect(resolveKey('')).rejects.toBeInstanceOf(ProviderError);
    });
    it('calls sync function source', async () => {
      expect(await resolveKey(() => 'sk-sync')).toBe('sk-sync');
    });
    it('calls async function source', async () => {
      expect(await resolveKey(async () => 'sk-async')).toBe('sk-async');
    });
    it('rejects when function returns empty', async () => {
      await expect(resolveKey(async () => '')).rejects.toBeInstanceOf(ProviderError);
    });
  });
});

describe('openaiModel', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('parses a successful completion', async () => {
    (fetch as unknown as { mockResolvedValue: (v: Response) => void }).mockResolvedValue(
      okJson({
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }),
    );
    const def = openaiModel('gpt-test', {
      cost: { costPer1kInput: 0.001, costPer1kOutput: 0.002 },
      keys: 'sk-x',
    });
    const ctx: ProviderCallContext = { model: def, apiKey: 'sk-x', attemptNumber: 0 };
    const req: CompletionRequest = { prompt: 'hi' };
    const r = await def.provider.complete(req, ctx);
    expect(r.text).toBe('hello');
    expect(r.toolCalls).toEqual([]);
    expect(r.finishReason).toBe('stop');
    expect(r.usage.inputTokens).toBe(5);
    expect(r.providerName).toBe('openai');
  });

  it('parses tool_calls in non-streaming response', async () => {
    (fetch as unknown as { mockResolvedValue: (v: Response) => void }).mockResolvedValue(
      okJson({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'c_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    );
    const def = openaiModel('gpt-test', {
      cost: { costPer1kInput: 0, costPer1kOutput: 0 },
      keys: 'sk-x',
    });
    const r = await def.provider.complete(
      {
        prompt: 'weather?',
        tools: [
          {
            name: 'get_weather',
            description: '...',
            parameters: { type: 'object', properties: {} },
          },
        ],
      },
      { model: def, apiKey: 'sk-x', attemptNumber: 0 },
    );
    expect(r.toolCalls).toEqual([{ id: 'c_1', name: 'get_weather', arguments: { city: 'Tokyo' } }]);
    expect(r.finishReason).toBe('tool-calls');
  });

  it('classifies a 429 as ProviderError(rate-limited)', async () => {
    (fetch as unknown as { mockResolvedValue: (v: Response) => void }).mockResolvedValue(
      errJson(429),
    );
    const def = openaiModel('gpt-test', {
      cost: { costPer1kInput: 0, costPer1kOutput: 0 },
      keys: 'sk-x',
    });
    await expect(
      def.provider.complete({ prompt: 'x' }, { model: def, apiKey: 'sk-x', attemptNumber: 0 }),
    ).rejects.toMatchObject({ classification: 'rate-limited', status: 429 });
  });

  it('translates network errors', async () => {
    (fetch as unknown as { mockRejectedValue: (v: unknown) => void }).mockRejectedValue(
      new TypeError('fetch failed'),
    );
    const def = openaiModel('gpt-test', {
      cost: { costPer1kInput: 0, costPer1kOutput: 0 },
      keys: 'sk-x',
    });
    await expect(
      def.provider.complete({ prompt: 'x' }, { model: def, apiKey: 'sk-x', attemptNumber: 0 }),
    ).rejects.toMatchObject({ classification: 'network' });
  });
});

describe('anthropicModel', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('parses a successful completion', async () => {
    (fetch as unknown as { mockResolvedValue: (v: Response) => void }).mockResolvedValue(
      okJson({
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 1 },
      }),
    );
    const def = anthropicModel('claude-test', {
      cost: { costPer1kInput: 0.001, costPer1kOutput: 0.002 },
      keys: 'sk-a',
    });
    const r = await def.provider.complete(
      { prompt: 'hi' },
      { model: def, apiKey: 'sk-a', attemptNumber: 0 },
    );
    expect(r.text).toBe('hi');
    expect(r.providerName).toBe('anthropic');
    expect(r.finishReason).toBe('stop');
  });

  it('classifies 529 as rate-limited', async () => {
    (fetch as unknown as { mockResolvedValue: (v: Response) => void }).mockResolvedValue(
      errJson(529, { error: { message: 'overloaded' } }),
    );
    const def = anthropicModel('claude-test', {
      cost: { costPer1kInput: 0, costPer1kOutput: 0 },
      keys: 'sk-a',
    });
    await expect(
      def.provider.complete({ prompt: 'x' }, { model: def, apiKey: 'sk-a', attemptNumber: 0 }),
    ).rejects.toMatchObject({ classification: 'rate-limited', status: 529 });
  });

  it('parses tool_use content blocks', async () => {
    (fetch as unknown as { mockResolvedValue: (v: Response) => void }).mockResolvedValue(
      okJson({
        content: [
          { type: 'text', text: 'looking up' },
          { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Tokyo' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    );
    const def = anthropicModel('claude-test', {
      cost: { costPer1kInput: 0, costPer1kOutput: 0 },
      keys: 'sk-a',
    });
    const r = await def.provider.complete(
      {
        prompt: 'weather?',
        tools: [
          { name: 'get_weather', description: '', parameters: { type: 'object', properties: {} } },
        ],
      },
      { model: def, apiKey: 'sk-a', attemptNumber: 0 },
    );
    expect(r.toolCalls).toEqual([
      { id: 'tu_1', name: 'get_weather', arguments: { city: 'Tokyo' } },
    ]);
    expect(r.finishReason).toBe('tool-calls');
  });
});

describe('geminiModel', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('parses a successful completion', async () => {
    (fetch as unknown as { mockResolvedValue: (v: Response) => void }).mockResolvedValue(
      okJson({
        candidates: [{ content: { parts: [{ text: 'hi gemini' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
      }),
    );
    const def = geminiModel('gemini-test', {
      cost: { costPer1kInput: 0, costPer1kOutput: 0 },
      keys: 'sk-g',
    });
    const r = await def.provider.complete(
      { prompt: 'hi' },
      { model: def, apiKey: 'sk-g', attemptNumber: 0 },
    );
    expect(r.text).toBe('hi gemini');
    expect(r.providerName).toBe('gemini');
    expect(r.finishReason).toBe('stop');
  });

  it('parses functionCall parts', async () => {
    (fetch as unknown as { mockResolvedValue: (v: Response) => void }).mockResolvedValue(
      okJson({
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'get_weather', args: { city: 'Tokyo' } } }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
      }),
    );
    const def = geminiModel('gemini-test', {
      cost: { costPer1kInput: 0, costPer1kOutput: 0 },
      keys: 'sk-g',
    });
    const r = await def.provider.complete(
      {
        prompt: 'weather?',
        tools: [
          { name: 'get_weather', description: '', parameters: { type: 'object', properties: {} } },
        ],
      },
      { model: def, apiKey: 'sk-g', attemptNumber: 0 },
    );
    expect(r.toolCalls).toEqual([
      { id: 'gemini-call-0', name: 'get_weather', arguments: { city: 'Tokyo' } },
    ]);
  });
});

describe('httpModel', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('uses default OpenAI-compatible builder + parser', async () => {
    (fetch as unknown as { mockResolvedValue: (v: Response) => void }).mockResolvedValue(
      okJson({
        choices: [{ message: { content: 'http-hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      }),
    );
    const def = httpModel('groq/llama', {
      baseUrl: 'https://api.groq.com/openai/v1',
      cost: { costPer1kInput: 0, costPer1kOutput: 0 },
      keys: 'sk-h',
    });
    const r = await def.provider.complete(
      { prompt: 'hi' },
      { model: def, apiKey: 'sk-h', attemptNumber: 0 },
    );
    expect(r.text).toBe('http-hi');
    expect(r.providerName).toBe('http');
  });
});
