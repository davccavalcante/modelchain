import type { CompletionChunk } from '../../types.js';
import { openAIStream } from './openai.js';

/**
 * Default normaliser for arbitrary OpenAI-compatible HTTP endpoints (Groq,
 * Together, DeepSeek, OpenRouter, Fireworks, Mistral La Plateforme, self-hosted
 * vLLM / LiteLLM, etc.).
 *
 * Re-uses the OpenAI normaliser because the SSE wire format is identical for
 * any endpoint that follows the OpenAI chat-completions spec.
 */
export function httpStream(body: ReadableStream<Uint8Array>): AsyncIterable<CompletionChunk> {
  return openAIStream(body);
}
