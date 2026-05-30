import { ProviderError } from '../errors.js';
import { anthropicStream } from '../streaming/normalizers/anthropic.js';
import { toolCallsFromAnthropic, toolsToAnthropic } from '../tools/translators/anthropic.js';
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResponse,
  CostProfile,
  FinishReason,
  ModelDefinition,
  ModelId,
  ParsedProviderError,
  ProviderAdapter,
  ProviderCallContext,
} from '../types.js';
import { classifyStatus, estimateTokens, parseRetryAfter } from './_shared.js';

/** Factory for an Anthropic Claude model definition. */
export interface AnthropicModelOptions {
  readonly cost: CostProfile;
  readonly keys: ModelDefinition['keys'];
  readonly baseUrl?: string;
  readonly anthropicVersion?: string;
  readonly estimatedLatencyP50Ms?: number;
  readonly capabilities?: readonly string[];
  readonly weight?: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

export function anthropicModel(modelId: string, options: AnthropicModelOptions): ModelDefinition {
  const provider = createAnthropicAdapter(
    options.baseUrl ?? 'https://api.anthropic.com/v1',
    options.anthropicVersion ?? '2023-06-01',
  );
  return {
    id: modelId as ModelId,
    provider,
    cost: options.cost,
    keys: options.keys,
    ...(options.estimatedLatencyP50Ms !== undefined
      ? { estimatedLatencyP50Ms: options.estimatedLatencyP50Ms }
      : {}),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    ...(options.weight !== undefined ? { weight: options.weight } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

function createAnthropicAdapter(baseUrl: string, anthropicVersion: string): ProviderAdapter {
  return {
    name: 'anthropic',
    complete: (request, context) => callAnthropic(baseUrl, anthropicVersion, request, context),
    stream: (request, context) => streamAnthropic(baseUrl, anthropicVersion, request, context),
    parseError: parseAnthropicError,
  };
}

function buildBody(request: CompletionRequest, modelId: string, stream: boolean): object {
  return {
    model: modelId,
    messages: [{ role: 'user', content: request.prompt }],
    max_tokens: request.maxTokens ?? 1024,
    stream,
    ...(request.system ? { system: request.system } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.stopSequences && request.stopSequences.length > 0
      ? { stop_sequences: [...request.stopSequences] }
      : {}),
    ...(request.tools && request.tools.length > 0
      ? { tools: toolsToAnthropic(request.tools) }
      : {}),
  };
}

async function callAnthropic(
  baseUrl: string,
  anthropicVersion: string,
  request: CompletionRequest,
  context: ProviderCallContext,
): Promise<CompletionResponse> {
  const start = Date.now();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': context.apiKey,
        'anthropic-version': anthropicVersion,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildBody(request, String(context.model.id), false)),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (err: unknown) {
    throw new ProviderError(
      'anthropic',
      String(context.model.id),
      'network',
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }
  if (!response.ok) {
    const parsed = await parseAnthropicResponse(response);
    throw new ProviderError(
      'anthropic',
      String(context.model.id),
      parsed.classification,
      parsed.message,
      parsed.status !== undefined ? { status: parsed.status } : {},
    );
  }
  const json = (await response.json()) as AnthropicMessagesResponse;
  const text =
    json.content
      ?.filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('') ?? '';
  const toolCalls = toolCallsFromAnthropic(json.content);
  return {
    text,
    toolCalls,
    finishReason: mapFinishReason(json.stop_reason),
    usage: {
      inputTokens:
        json.usage?.input_tokens ?? estimateTokens(request.prompt + (request.system ?? '')),
      outputTokens: json.usage?.output_tokens ?? estimateTokens(text),
      totalTokens:
        (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0) ||
        estimateTokens(request.prompt + (request.system ?? '') + text),
    },
    modelId: context.model.id as ModelId,
    providerName: 'anthropic',
    latencyMs: Date.now() - start,
    rawProviderResponse: json,
  };
}

async function* streamAnthropic(
  baseUrl: string,
  anthropicVersion: string,
  request: CompletionRequest,
  context: ProviderCallContext,
): AsyncIterable<CompletionChunk> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': context.apiKey,
        'anthropic-version': anthropicVersion,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(buildBody(request, String(context.model.id), true)),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (err: unknown) {
    throw new ProviderError(
      'anthropic',
      String(context.model.id),
      'network',
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }
  if (!response.ok || !response.body) {
    const parsed = await parseAnthropicResponse(response);
    throw new ProviderError(
      'anthropic',
      String(context.model.id),
      parsed.classification,
      parsed.message,
      parsed.status !== undefined ? { status: parsed.status } : {},
    );
  }
  yield* anthropicStream(response.body);
}

function mapFinishReason(reason: string | undefined): FinishReason {
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

async function parseAnthropicResponse(response: Response): Promise<ParsedProviderError> {
  const classification = response.status === 529 ? 'rate-limited' : classifyStatus(response.status);
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } } | null;
    if (body?.error?.message) message = body.error.message;
  } catch {
    // body not JSON
  }
  return retryAfterMs !== undefined
    ? { status: response.status, classification, retryAfterMs, message }
    : { status: response.status, classification, message };
}

function parseAnthropicError(error: unknown): ParsedProviderError {
  if (error instanceof ProviderError) {
    return error.status !== undefined
      ? { status: error.status, classification: error.classification, message: error.message }
      : { classification: error.classification, message: error.message };
  }
  return {
    classification: 'unknown',
    message: error instanceof Error ? error.message : String(error),
  };
}

interface AnthropicMessagesResponse {
  readonly content?: ReadonlyArray<{
    readonly type?: string;
    readonly text?: string;
  }>;
  readonly stop_reason?: string;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
}
