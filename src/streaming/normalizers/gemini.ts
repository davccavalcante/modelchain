import type { CompletionChunk, FinishReason, TokenUsage } from '../../types.js';

/**
 * Normalise the Gemini `streamGenerateContent` response into `CompletionChunk`s.
 *
 * Gemini's streaming endpoint returns a JSON ARRAY (when `alt=sse` is not set)
 * - one element per chunk. When `alt=sse` IS set, the server emits SSE events
 * whose data is the same JSON shape. We handle both: callers may pass either
 * the raw response body OR an already-decoded JSON array via `geminiStreamFromJson`.
 *
 * This implementation reads the raw stream as text and incrementally parses
 * top-level JSON objects from a streaming array.
 */
export async function* geminiStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<CompletionChunk> {
  let finishReason: FinishReason = 'stop';
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  /** Index for partial tool calls across chunks. */
  let toolCallIndex = 0;

  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();
      // Try to extract complete JSON objects from buffer
      let objectStart = -1;
      let depth = 0;
      let inString = false;
      let escaped = false;
      const objects: string[] = [];
      for (let i = 0; i < buffer.length; i += 1) {
        const ch = buffer[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (inString) {
          if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === '{') {
          if (depth === 0) objectStart = i;
          depth += 1;
        } else if (ch === '}') {
          depth -= 1;
          if (depth === 0 && objectStart >= 0) {
            objects.push(buffer.slice(objectStart, i + 1));
            objectStart = -1;
          }
        }
      }
      // Remove consumed prefix
      if (objects.length > 0) {
        const lastEnd =
          buffer.lastIndexOf(objects[objects.length - 1] as string) +
          (objects[objects.length - 1] as string).length;
        buffer = buffer.slice(lastEnd);
      }
      for (const raw of objects) {
        let event: GeminiStreamEvent;
        try {
          event = JSON.parse(raw) as GeminiStreamEvent;
        } catch {
          continue;
        }
        const candidate = event.candidates?.[0];
        if (!candidate) continue;
        const parts = candidate.content?.parts ?? [];
        for (const part of parts) {
          if (typeof part.text === 'string') {
            yield { type: 'text-delta', delta: part.text };
          } else if (part.functionCall?.name) {
            const id = `gemini-call-${toolCallIndex}`;
            yield {
              type: 'tool-call-delta',
              toolCall: {
                index: toolCallIndex,
                id,
                name: part.functionCall.name,
                argumentsDelta: JSON.stringify(part.functionCall.args ?? {}),
              },
            };
            toolCallIndex += 1;
          }
        }
        if (candidate.finishReason) {
          finishReason = mapFinishReason(candidate.finishReason);
        }
        if (event.usageMetadata) {
          inputTokens = event.usageMetadata.promptTokenCount ?? inputTokens;
          outputTokens = event.usageMetadata.candidatesTokenCount ?? outputTokens;
          totalTokens = event.usageMetadata.totalTokenCount ?? totalTokens;
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  const usage: TokenUsage = {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens || inputTokens + outputTokens,
  };
  yield { type: 'finish', finishReason, usage };
}

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
      return 'content-filter';
    default:
      return 'stop';
  }
}

interface GeminiStreamEvent {
  readonly candidates?: ReadonlyArray<{
    readonly content?: {
      readonly parts?: ReadonlyArray<{
        readonly text?: string;
        readonly functionCall?: { readonly name?: string; readonly args?: unknown };
      }>;
    };
    readonly finishReason?: string;
  }>;
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
    readonly totalTokenCount?: number;
  };
}
