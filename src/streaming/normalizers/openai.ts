import type { CompletionChunk, FinishReason, TokenUsage } from '../../types.js';
import { readSse } from '../reader.js';

/**
 * Normalise the OpenAI chat-completions SSE stream into modelchain
 * `CompletionChunk`s. Yields exactly one `finish` chunk at the end.
 */
export async function* openAIStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<CompletionChunk> {
  let finishReason: FinishReason = 'stop';
  let usage: TokenUsage | undefined;
  for await (const payload of readSse(body)) {
    if (payload === '[DONE]') break;
    let event: OpenAIStreamEvent;
    try {
      event = JSON.parse(payload) as OpenAIStreamEvent;
    } catch {
      continue;
    }
    if (event.usage) {
      usage = {
        inputTokens: event.usage.prompt_tokens ?? 0,
        outputTokens: event.usage.completion_tokens ?? 0,
        totalTokens: event.usage.total_tokens ?? 0,
      };
    }
    const choice = event.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;
    if (delta?.content) {
      yield { type: 'text-delta', delta: delta.content };
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const partial: { index: number; id?: string; name?: string; argumentsDelta?: string } = {
          index: tc.index,
        };
        if (tc.id) partial.id = tc.id;
        if (tc.function?.name) partial.name = tc.function.name;
        if (tc.function?.arguments) partial.argumentsDelta = tc.function.arguments;
        yield { type: 'tool-call-delta', toolCall: partial };
      }
    }
    if (choice.finish_reason) {
      finishReason = mapFinishReason(choice.finish_reason);
    }
  }
  yield usage ? { type: 'finish', finishReason, usage } : { type: 'finish', finishReason };
}

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls';
    case 'content_filter':
      return 'content-filter';
    default:
      return 'stop';
  }
}

interface OpenAIStreamEvent {
  readonly choices?: ReadonlyArray<{
    readonly delta?: {
      readonly content?: string;
      readonly tool_calls?: ReadonlyArray<{
        readonly index: number;
        readonly id?: string;
        readonly type?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }>;
    };
    readonly finish_reason?: string;
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
}
