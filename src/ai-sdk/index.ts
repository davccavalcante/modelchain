/**
 * @takk/modelchain/ai-sdk
 *
 * Vercel AI SDK adapter. Turns a `ModelchainRouter` into a `LanguageModelV2`
 * that the `ai` package (Vercel AI SDK >=5) can consume directly via
 * `generateText`, `streamText`, `generateObject`, etc.
 *
 * Usage:
 * ```ts
 * import { generateText } from 'ai';
 * import { toVercelAILanguageModel } from '@takk/modelchain/ai-sdk';
 * import { createModelchain } from '@takk/modelchain';
 * import { openaiModel } from '@takk/modelchain/providers';
 *
 * const router = createModelchain({ models: [...] });
 * const { text } = await generateText({
 *   model: toVercelAILanguageModel(router),
 *   prompt: 'Hello.',
 * });
 * ```
 *
 * The `@ai-sdk/provider` package is an OPTIONAL peer dependency.
 * The adapter structurally satisfies `LanguageModelV2` from
 * `@ai-sdk/provider@>=3` (peer dependency range).
 */

import type {
  CompletionRequest,
  ModelchainRouter,
  PartialToolCall,
  ToolDefinition,
} from '../types.js';

/** Options passed to the Vercel AI SDK adapter. */
export interface ToVercelAIOptions {
  /** Optional model id label shown in the AI SDK metadata. Defaults to `modelchain`. */
  readonly modelId?: string;
}

/**
 * Convert a `ModelchainRouter` to a `LanguageModelV2`-compatible adapter.
 *
 * The returned value satisfies the Vercel AI SDK's `LanguageModelV2`
 * interface structurally. Consumers should cast via the `LanguageModelV2`
 * type they import from `@ai-sdk/provider`:
 *
 * ```ts
 * import type { LanguageModelV2 } from '@ai-sdk/provider';
 * const model: LanguageModelV2 = toVercelAILanguageModel(router) as LanguageModelV2;
 * ```
 *
 * We return `LanguageModelV2Like` (a local structural alias) to avoid a
 * compile-time dependency on `@ai-sdk/provider` while still expressing the
 * shape clearly in TypeScript.
 */
export function toVercelAILanguageModel(
  router: ModelchainRouter,
  options: ToVercelAIOptions = {},
): LanguageModelV2Like {
  const modelId = options.modelId ?? 'modelchain';
  return {
    specificationVersion: 'v2',
    provider: 'modelchain',
    modelId,
    supportedUrls: {},

    async doGenerate(opts: V2CallOptions): Promise<V2GenerateResult> {
      const request = vercelOptionsToCompletionRequest(opts);
      const response = await router.complete(request);
      const content: V2Content[] = [];
      if (response.text.length > 0) {
        content.push({ type: 'text', text: response.text });
      }
      for (const tc of response.toolCalls) {
        content.push({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.name,
          input: JSON.stringify(tc.arguments),
        });
      }
      return {
        content,
        finishReason: mapFinishReasonOut(response.finishReason),
        usage: usageOut(response.usage),
        warnings: [],
        response: {
          id: `modelchain-${response.modelId}-${response.latencyMs}`,
          modelId: response.modelId,
          timestamp: new Date(),
        },
        request: { body: opts },
      };
    },

    async doStream(opts: V2CallOptions): Promise<V2StreamResult> {
      const request = vercelOptionsToCompletionRequest(opts);
      const stream = new ReadableStream<V2StreamPart>({
        async start(controller) {
          try {
            controller.enqueue({ type: 'stream-start', warnings: [] });

            const textPartId = 'text-1';
            let textStarted = false;
            let textEnded = false;
            /** Accumulators per partial tool call index */
            const toolState = new Map<
              number,
              {
                id: string;
                name: string;
                argsAccumulated: string;
                inputStarted: boolean;
                inputEnded: boolean;
              }
            >();
            let lastUsage: V2Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
            let lastFinish: V2FinishReason = 'stop';

            for await (const chunk of router.stream(request)) {
              if (chunk.type === 'text-delta') {
                if (!textStarted) {
                  controller.enqueue({ type: 'text-start', id: textPartId });
                  textStarted = true;
                }
                controller.enqueue({ type: 'text-delta', id: textPartId, delta: chunk.delta });
              } else if (chunk.type === 'tool-call-delta') {
                handleToolCallDelta(chunk.toolCall, toolState, controller);
              } else if (chunk.type === 'finish') {
                if (textStarted && !textEnded) {
                  controller.enqueue({ type: 'text-end', id: textPartId });
                  textEnded = true;
                }
                // Close any open tool inputs and emit final tool-call events
                for (const [, state] of toolState) {
                  if (state.inputStarted && !state.inputEnded) {
                    controller.enqueue({ type: 'tool-input-end', id: `tool-${state.id}` });
                    state.inputEnded = true;
                  }
                  controller.enqueue({
                    type: 'tool-call',
                    toolCallId: state.id,
                    toolName: state.name,
                    input: state.argsAccumulated || '{}',
                  });
                }
                lastFinish = mapFinishReasonOut(chunk.finishReason);
                if (chunk.usage) lastUsage = usageOut(chunk.usage);
              }
            }

            // Defensive close if router somehow exits without a finish chunk.
            if (textStarted && !textEnded) {
              controller.enqueue({ type: 'text-end', id: textPartId });
            }

            controller.enqueue({
              type: 'finish',
              finishReason: lastFinish,
              usage: lastUsage,
            });
            controller.close();
          } catch (err: unknown) {
            controller.enqueue({ type: 'error', error: err });
            controller.close();
          }
        },
      });
      return {
        stream,
        request: { body: opts },
        response: {
          id: `modelchain-stream-${modelId}`,
          modelId,
          timestamp: new Date(),
        },
      };
    },
  };
}

function handleToolCallDelta(
  partial: PartialToolCall,
  toolState: Map<
    number,
    {
      id: string;
      name: string;
      argsAccumulated: string;
      inputStarted: boolean;
      inputEnded: boolean;
    }
  >,
  controller: ReadableStreamDefaultController<V2StreamPart>,
): void {
  const existing = toolState.get(partial.index);
  if (!existing) {
    if (!partial.id || !partial.name) {
      // First delta must carry id+name to start the input lifecycle.
      // Otherwise queue partial for next delta.
      return;
    }
    controller.enqueue({
      type: 'tool-input-start',
      id: `tool-${partial.id}`,
      toolName: partial.name,
    });
    const state = {
      id: partial.id,
      name: partial.name,
      argsAccumulated: partial.argumentsDelta ?? '',
      inputStarted: true,
      inputEnded: false,
    };
    toolState.set(partial.index, state);
    if (partial.argumentsDelta) {
      controller.enqueue({
        type: 'tool-input-delta',
        id: `tool-${partial.id}`,
        delta: partial.argumentsDelta,
      });
    }
    return;
  }
  // Existing partial: emit incremental delta if any.
  if (partial.argumentsDelta) {
    existing.argsAccumulated += partial.argumentsDelta;
    controller.enqueue({
      type: 'tool-input-delta',
      id: `tool-${existing.id}`,
      delta: partial.argumentsDelta,
    });
  }
}

function vercelOptionsToCompletionRequest(opts: V2CallOptions): CompletionRequest {
  const { prompt, system } = extractPromptAndSystem(opts);
  const request: {
    prompt: string;
    system?: string;
    maxTokens?: number;
    temperature?: number;
    stopSequences?: readonly string[];
    tools?: readonly ToolDefinition[];
    signal?: AbortSignal;
  } = { prompt };
  if (system) request.system = system;
  if (opts.maxOutputTokens !== undefined) request.maxTokens = opts.maxOutputTokens;
  if (opts.temperature !== undefined) request.temperature = opts.temperature;
  if (opts.stopSequences && opts.stopSequences.length > 0) {
    request.stopSequences = opts.stopSequences;
  }
  if (opts.tools && opts.tools.length > 0) {
    request.tools = vercelToolsToModelchain(opts.tools);
  }
  if (opts.abortSignal) request.signal = opts.abortSignal;
  return request;
}

function extractPromptAndSystem(opts: V2CallOptions): { prompt: string; system?: string } {
  if (typeof opts.prompt === 'string') return { prompt: opts.prompt };
  if (Array.isArray(opts.prompt)) {
    let system: string | undefined;
    const userParts: string[] = [];
    for (const msg of opts.prompt) {
      if (msg.role === 'system' && typeof msg.content === 'string') {
        system = msg.content;
      } else if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          userParts.push(msg.content);
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text' && typeof part.text === 'string') {
              userParts.push(part.text);
            }
          }
        }
      }
    }
    const result: { prompt: string; system?: string } = { prompt: userParts.join('\n') };
    if (system) result.system = system;
    return result;
  }
  return { prompt: '' };
}

function vercelToolsToModelchain(tools: readonly V2Tool[]): readonly ToolDefinition[] {
  return tools
    .filter((t) => t.type === 'function' && t.name && t.inputSchema)
    .map((t) => ({
      name: t.name,
      description: t.description ?? '',
      parameters: {
        type: 'object',
        properties: (t.inputSchema?.properties ?? {}) as Readonly<Record<string, never>>,
        ...(t.inputSchema?.required ? { required: [...t.inputSchema.required] } : {}),
      },
    }));
}

function mapFinishReasonOut(
  reason: 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error',
): V2FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool-calls':
      return 'tool-calls';
    case 'content-filter':
      return 'content-filter';
    case 'error':
      return 'error';
    default:
      return 'stop';
  }
}

function usageOut(usage: {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}): V2Usage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

// ─── Structural types matching @ai-sdk/provider@>=3 LanguageModelV2 ───
// These local aliases avoid a compile-time dependency on @ai-sdk/provider
// while keeping the shape transparent to TypeScript. Consumers who install
// `@ai-sdk/provider` can `as LanguageModelV2` cast the return value.

/** Local alias matching `LanguageModelV2` from `@ai-sdk/provider@>=3`. */
export interface LanguageModelV2Like {
  readonly specificationVersion: 'v2';
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: Readonly<Record<string, readonly RegExp[]>>;
  readonly doGenerate: (options: V2CallOptions) => Promise<V2GenerateResult>;
  readonly doStream: (options: V2CallOptions) => Promise<V2StreamResult>;
}

interface V2CallOptions {
  readonly prompt:
    | string
    | ReadonlyArray<{
        readonly role: 'system' | 'user' | 'assistant' | 'tool';
        readonly content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>;
      }>;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly stopSequences?: readonly string[];
  readonly tools?: readonly V2Tool[];
  readonly abortSignal?: AbortSignal;
}

interface V2Tool {
  readonly type: 'function';
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: {
    readonly type: string;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  };
}

interface V2GenerateResult {
  readonly content: readonly V2Content[];
  readonly finishReason: V2FinishReason;
  readonly usage: V2Usage;
  readonly warnings: readonly never[];
  readonly response: { readonly id: string; readonly modelId: string; readonly timestamp: Date };
  readonly request: { readonly body: unknown };
}

interface V2StreamResult {
  readonly stream: ReadableStream<V2StreamPart>;
  readonly request: { readonly body: unknown };
  readonly response: { readonly id: string; readonly modelId: string; readonly timestamp: Date };
}

type V2Content =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: string;
    };

type V2StreamPart =
  | { readonly type: 'stream-start'; readonly warnings: readonly never[] }
  | { readonly type: 'text-start'; readonly id: string }
  | { readonly type: 'text-delta'; readonly id: string; readonly delta: string }
  | { readonly type: 'text-end'; readonly id: string }
  | { readonly type: 'tool-input-start'; readonly id: string; readonly toolName: string }
  | { readonly type: 'tool-input-delta'; readonly id: string; readonly delta: string }
  | { readonly type: 'tool-input-end'; readonly id: string }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: string;
    }
  | {
      readonly type: 'finish';
      readonly finishReason: V2FinishReason;
      readonly usage: V2Usage;
    }
  | { readonly type: 'error'; readonly error: unknown };

type V2FinishReason =
  | 'stop'
  | 'length'
  | 'tool-calls'
  | 'content-filter'
  | 'error'
  | 'other'
  | 'unknown';

interface V2Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}
