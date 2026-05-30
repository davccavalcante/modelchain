import type { CompletionChunk, FinishReason, TokenUsage } from '../../types.js';
import { readSse } from '../reader.js';

/**
 * Normalise the Anthropic Messages streaming format into `CompletionChunk`s.
 *
 * Anthropic emits these event types (one per SSE event):
 *   - message_start          (metadata + usage.input_tokens)
 *   - content_block_start    (text or tool_use block beginning)
 *   - content_block_delta    (text delta or input_json_delta)
 *   - content_block_stop
 *   - message_delta          (stop_reason + usage.output_tokens)
 *   - message_stop
 */
export async function* anthropicStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<CompletionChunk> {
  let finishReason: FinishReason = 'stop';
  let inputTokens = 0;
  let outputTokens = 0;
  /** Map from content_block index -> partial tool call info. */
  const toolCallIndex = new Map<number, { id: string; name: string }>();

  for await (const payload of readSse(body)) {
    let event: AnthropicStreamEvent;
    try {
      event = JSON.parse(payload) as AnthropicStreamEvent;
    } catch {
      continue;
    }
    switch (event.type) {
      case 'message_start': {
        const usage = event.message?.usage;
        if (usage?.input_tokens !== undefined) inputTokens = usage.input_tokens;
        if (usage?.output_tokens !== undefined) outputTokens = usage.output_tokens;
        break;
      }
      case 'content_block_start': {
        const block = event.content_block;
        const index = event.index ?? 0;
        if (block?.type === 'tool_use' && block.id && block.name) {
          toolCallIndex.set(index, { id: block.id, name: block.name });
          yield {
            type: 'tool-call-delta',
            toolCall: { index, id: block.id, name: block.name },
          };
        }
        break;
      }
      case 'content_block_delta': {
        const delta = event.delta;
        const index = event.index ?? 0;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'text-delta', delta: delta.text };
        } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          yield {
            type: 'tool-call-delta',
            toolCall: { index, argumentsDelta: delta.partial_json },
          };
        }
        break;
      }
      case 'message_delta': {
        if (event.delta?.stop_reason) {
          finishReason = mapFinishReason(event.delta.stop_reason);
        }
        if (event.usage?.output_tokens !== undefined) {
          outputTokens = event.usage.output_tokens;
        }
        break;
      }
      case 'message_stop':
        // End of stream marker
        break;
      default:
        break;
    }
  }

  const usage: TokenUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
  yield { type: 'finish', finishReason, usage };
}

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool-calls';
    case 'stop_sequence':
      return 'stop';
    default:
      return 'stop';
  }
}

interface AnthropicStreamEvent {
  readonly type?: string;
  readonly index?: number;
  readonly message?: {
    readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
  };
  readonly content_block?: {
    readonly type?: string;
    readonly id?: string;
    readonly name?: string;
  };
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
    readonly partial_json?: string;
    readonly stop_reason?: string;
  };
  readonly usage?: { readonly output_tokens?: number };
}
