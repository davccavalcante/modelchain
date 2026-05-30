import { describe, expect, it } from 'vitest';
import { createModelchain } from '../../src/core/createModelchain.js';
import { AllModelsExhaustedError, ProviderError } from '../../src/errors.js';
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResponse,
  ModelDefinition,
  ProviderAdapter,
  TelemetryEvent,
} from '../../src/types.js';

type Outcome =
  | {
      kind: 'ok';
      text: string;
      latencyMs?: number;
      tokens?: number;
      toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
    }
  | {
      kind: 'fail';
      status: number;
      classification: ProviderError['classification'];
      message: string;
    }
  | { kind: 'stream'; chunks: CompletionChunk[] };

function fakeProvider(name: string, script: Outcome[]): ProviderAdapter {
  let cursor = 0;
  return {
    name,
    complete: (_request, context) => {
      const outcome = script[cursor] ?? script[script.length - 1];
      cursor += 1;
      if (!outcome) return Promise.reject(new Error('no outcome'));
      if (outcome.kind === 'ok') {
        const tokens = outcome.tokens ?? 10;
        return Promise.resolve({
          text: outcome.text,
          toolCalls: outcome.toolCalls ?? [],
          finishReason: outcome.toolCalls && outcome.toolCalls.length > 0 ? 'tool-calls' : 'stop',
          usage: { inputTokens: tokens, outputTokens: tokens, totalTokens: tokens * 2 },
          modelId: context.model.id as never,
          providerName: name,
          latencyMs: outcome.latencyMs ?? 10,
        } satisfies CompletionResponse);
      }
      if (outcome.kind === 'fail') {
        return Promise.reject(
          new ProviderError(
            name,
            String(context.model.id),
            outcome.classification,
            outcome.message,
            {
              status: outcome.status,
            },
          ),
        );
      }
      return Promise.reject(new Error('stream outcome used in complete()'));
    },
    stream: async function* (_request, _context) {
      const outcome = script[cursor] ?? script[script.length - 1];
      cursor += 1;
      if (!outcome) throw new Error('no outcome');
      if (outcome.kind === 'stream') {
        for (const chunk of outcome.chunks) yield chunk;
        return;
      }
      if (outcome.kind === 'fail') {
        throw new ProviderError(
          name,
          String(_context.model.id),
          outcome.classification,
          outcome.message,
          {
            status: outcome.status,
          },
        );
      }
      // ok outcome converted to a single text + finish stream
      if (outcome.kind === 'ok') {
        yield { type: 'text-delta', delta: outcome.text };
        yield {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
    },
    parseError: (err) => ({
      classification: err instanceof ProviderError ? err.classification : 'unknown',
      message: err instanceof Error ? err.message : String(err),
    }),
  };
}

const def = (
  id: string,
  provider: ProviderAdapter,
  costIn = 0.001,
  costOut = 0.002,
): ModelDefinition => ({
  id,
  provider,
  cost: { costPer1kInput: costIn, costPer1kOutput: costOut },
  keys: 'sk-test',
});

describe('router end-to-end', () => {
  it('returns successfully via cost-then-quality default strategy', async () => {
    const router = createModelchain({
      models: [def('m1', fakeProvider('p', [{ kind: 'ok', text: 'hello' }]))],
    });
    const r = await router.complete({ prompt: 'hi' });
    expect(r.text).toBe('hello');
    expect(r.toolCalls).toEqual([]);
    expect(r.finishReason).toBe('stop');
    await router.close();
  });

  it('throws when constructed with empty models', () => {
    expect(() => createModelchain({ models: [] })).toThrow();
  });

  it('fails over to the next model after a server-error', async () => {
    const failing = fakeProvider('p1', [
      { kind: 'fail', status: 500, classification: 'server-error', message: 'down' },
      { kind: 'fail', status: 500, classification: 'server-error', message: 'still' },
      { kind: 'fail', status: 500, classification: 'server-error', message: 'still' },
      { kind: 'fail', status: 500, classification: 'server-error', message: 'still' },
    ]);
    const winning = fakeProvider('p2', [{ kind: 'ok', text: 'recovered' }]);
    const router = createModelchain({
      models: [def('failing', failing), def('winning', winning)],
      strategy: 'sequential-fallback',
      retry: { max: 1, baseMs: 1, jitter: false },
    });
    const r = await router.complete({ prompt: 'hi' });
    expect(r.text).toBe('recovered');
    await router.close();
  });

  it('throws AllModelsExhaustedError when every model fails terminally', async () => {
    const router = createModelchain({
      models: [
        def(
          'm',
          fakeProvider('p', [
            { kind: 'fail', status: 400, classification: 'bad-request', message: 'invalid' },
          ]),
        ),
      ],
      retry: { max: 0, baseMs: 1, jitter: false },
    });
    await expect(router.complete({ prompt: 'hi' })).rejects.toBeInstanceOf(AllModelsExhaustedError);
    await router.close();
  });

  it('emits telemetry events including toolCallCount and finishReason', async () => {
    const seen: TelemetryEvent[] = [];
    const router = createModelchain({
      models: [
        def(
          'm',
          fakeProvider('p', [
            {
              kind: 'ok',
              text: '',
              toolCalls: [{ id: 'c', name: 'do', arguments: { x: 1 } }],
            },
          ]),
        ),
      ],
      telemetry: { enabled: true },
    });
    router.on((e) => seen.push(e));
    await router.complete({ prompt: 'hi' });
    const success = seen.find((e) => e.type === 'request.success');
    expect(success?.type).toBe('request.success');
    if (success?.type === 'request.success') {
      expect(success.finishReason).toBe('tool-calls');
      expect(success.toolCallCount).toBe(1);
    }
    await router.close();
  });

  it('streaming yields text-delta and a finish', async () => {
    const router = createModelchain({
      models: [
        def(
          'm',
          fakeProvider('p', [
            {
              kind: 'stream',
              chunks: [
                { type: 'text-delta', delta: 'hi' },
                {
                  type: 'finish',
                  finishReason: 'stop',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ],
            },
          ]),
        ),
      ],
      telemetry: { enabled: true },
    });
    const seen: string[] = [];
    router.on((e) => seen.push(e.type));
    const collected: CompletionChunk[] = [];
    for await (const chunk of router.stream({ prompt: 'hi' })) {
      collected.push(chunk);
    }
    expect(collected.map((c) => c.type)).toEqual(['text-delta', 'finish']);
    expect(seen).toContain('stream.start');
    expect(seen).toContain('stream.finish');
    await router.close();
  });

  it('streaming surfaces ProviderError via AllModelsExhaustedError', async () => {
    const router = createModelchain({
      models: [
        def(
          'm',
          fakeProvider('p', [
            { kind: 'fail', status: 400, classification: 'bad-request', message: 'invalid' },
          ]),
        ),
      ],
      retry: { max: 0, baseMs: 1, jitter: false },
    });
    const consume = async () => {
      for await (const _chunk of router.stream({ prompt: 'hi' })) {
        // discard
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(AllModelsExhaustedError);
    await router.close();
  });

  it('opens the circuit after threshold consecutive failures', async () => {
    const seen: string[] = [];
    const router = createModelchain({
      models: [
        def(
          'm',
          fakeProvider('p', [
            { kind: 'fail', status: 500, classification: 'server-error', message: 'a' },
            { kind: 'fail', status: 500, classification: 'server-error', message: 'b' },
            { kind: 'fail', status: 500, classification: 'server-error', message: 'c' },
            { kind: 'fail', status: 500, classification: 'server-error', message: 'd' },
            { kind: 'fail', status: 500, classification: 'server-error', message: 'e' },
          ]),
        ),
      ],
      retry: { max: 0, baseMs: 1, jitter: false },
      circuitBreaker: { threshold: 2, cooldownMs: 10_000 },
      telemetry: { enabled: true },
    });
    router.on((e) => seen.push(e.type));
    await expect(router.complete({ prompt: 'hi' })).rejects.toBeDefined();
    await expect(router.complete({ prompt: 'hi' })).rejects.toBeDefined();
    expect(seen).toContain('circuit.open');
    await router.close();
  });

  it('streaming respects signal.aborted mid-stream', async () => {
    const controller = new AbortController();
    const longRunningProvider: ProviderAdapter = {
      name: 'p',
      complete: () => Promise.reject(new Error('not used in stream test')),
      stream: async function* (request: CompletionRequest) {
        for (let i = 0; i < 100; i++) {
          if (request.signal?.aborted) {
            throw new DOMException('aborted', 'AbortError');
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          yield { type: 'text-delta', delta: `chunk-${i}` };
        }
        yield {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 100, totalTokens: 101 },
        };
      },
      parseError: (err: unknown) => ({
        classification: 'network' as const,
        message: err instanceof Error ? err.message : String(err),
      }),
    };
    const router = createModelchain({ models: [def('m', longRunningProvider)] });
    const collected: string[] = [];
    let caught: unknown;
    try {
      for await (const chunk of router.stream({ prompt: 'hi', signal: controller.signal })) {
        if (chunk.type === 'text-delta') {
          collected.push(chunk.delta);
          if (collected.length === 3) controller.abort();
        }
      }
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(collected.length).toBeGreaterThanOrEqual(3);
    expect(collected.length).toBeLessThan(100);
    const snap = router.inspect();
    expect(snap.totalStreams).toBe(1);
    await router.close();
  });

  it('inspect exposes both totalRequests and totalStreams', async () => {
    const router = createModelchain({
      models: [
        def(
          'm',
          fakeProvider('p', [
            { kind: 'ok', text: 'a' },
            {
              kind: 'stream',
              chunks: [
                { type: 'text-delta', delta: 'b' },
                {
                  type: 'finish',
                  finishReason: 'stop',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ],
            },
          ]),
        ),
      ],
    });
    await router.complete({ prompt: 'hi' });
    for await (const _ of router.stream({ prompt: 'hi' })) {
      // drain
    }
    const snap = router.inspect();
    expect(snap.totalRequests).toBe(1);
    expect(snap.totalStreams).toBe(1);
    await router.close();
  });
});
