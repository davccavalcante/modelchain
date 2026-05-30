import { ProviderError } from '../errors.js';
import { httpStream } from '../streaming/normalizers/http.js';
import { readSse } from '../streaming/reader.js';
import { toolCallsFromHttp, toolsToHttp } from '../tools/translators/http.js';
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

/**
 * Factory for any OpenAI-compatible HTTP endpoint plus arbitrary REST endpoints
 * mapped via `buildRequest` and `parseResponse`.
 */
export interface HttpModelOptions {
  readonly cost: CostProfile;
  readonly keys: ModelDefinition['keys'];
  readonly baseUrl: string;
  readonly authHeader?: (key: string) => Record<string, string>;
  readonly buildRequest?: (
    request: CompletionRequest,
    modelId: string,
  ) => { readonly path: string; readonly headers: Record<string, string>; readonly body: unknown };
  readonly parseResponse?: (
    json: unknown,
    request: CompletionRequest,
  ) => {
    text: string;
    toolCalls?: readonly { id: string; name: string; arguments: Record<string, unknown> }[];
    finishReason?: FinishReason;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  /**
   * Optional custom stream parser. When provided, modelchain reads SSE
   * payloads from the response body and forwards each to this callback;
   * the callback yields normalised `CompletionChunk`s. When omitted, the
   * default OpenAI-compatible SSE normaliser is used.
   */
  readonly parseStream?: (
    payload: string,
    request: CompletionRequest,
  ) => Iterable<CompletionChunk> | AsyncIterable<CompletionChunk>;
  readonly estimatedLatencyP50Ms?: number;
  readonly capabilities?: readonly string[];
  readonly weight?: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

export function httpModel(modelId: string, options: HttpModelOptions): ModelDefinition {
  const provider = createHttpAdapter(options);
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

function createHttpAdapter(options: HttpModelOptions): ProviderAdapter {
  return {
    name: 'http',
    complete: (request, context) => callHttp(options, request, context, false),
    stream: (request, context) => streamHttp(options, request, context),
    parseError: parseHttpError,
  };
}

function defaultOpenAICompatBuilder(
  request: CompletionRequest,
  modelId: string,
  stream: boolean,
): { path: string; headers: Record<string, string>; body: unknown } {
  const messages: Array<{ role: string; content: string }> = [];
  if (request.system) messages.push({ role: 'system', content: request.system });
  messages.push({ role: 'user', content: request.prompt });
  return {
    path: '/chat/completions',
    headers: stream ? { Accept: 'text/event-stream' } : {},
    body: {
      model: modelId,
      messages,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.stopSequences && request.stopSequences.length > 0
        ? { stop: [...request.stopSequences] }
        : {}),
      ...(request.tools && request.tools.length > 0 ? { tools: toolsToHttp(request.tools) } : {}),
    },
  };
}

function defaultOpenAICompatParser(
  json: unknown,
  _request: CompletionRequest,
): {
  text: string;
  toolCalls: readonly { id: string; name: string; arguments: Record<string, unknown> }[];
  finishReason: FinishReason;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} {
  const j = json as {
    choices?: ReadonlyArray<{
      message?: { content?: string; tool_calls?: unknown };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const choice = j.choices?.[0];
  return {
    text: choice?.message?.content ?? '',
    toolCalls: toolCallsFromHttp(choice?.message?.tool_calls),
    finishReason: mapFinishReason(choice?.finish_reason),
    ...(j.usage?.prompt_tokens !== undefined ? { inputTokens: j.usage.prompt_tokens } : {}),
    ...(j.usage?.completion_tokens !== undefined
      ? { outputTokens: j.usage.completion_tokens }
      : {}),
    ...(j.usage?.total_tokens !== undefined ? { totalTokens: j.usage.total_tokens } : {}),
  };
}

async function callHttp(
  options: HttpModelOptions,
  request: CompletionRequest,
  context: ProviderCallContext,
  stream: boolean,
): Promise<CompletionResponse> {
  const start = Date.now();
  const built = options.buildRequest
    ? options.buildRequest(request, String(context.model.id))
    : defaultOpenAICompatBuilder(request, String(context.model.id), stream);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.authHeader
      ? options.authHeader(context.apiKey)
      : { Authorization: `Bearer ${context.apiKey}` }),
    ...built.headers,
  };
  const url = `${options.baseUrl.replace(/\/$/, '')}${built.path.startsWith('/') ? built.path : `/${built.path}`}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(built.body),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (err: unknown) {
    throw new ProviderError(
      'http',
      String(context.model.id),
      'network',
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }
  if (!response.ok) {
    const parsed = await parseHttpResponse(response);
    throw new ProviderError(
      'http',
      String(context.model.id),
      parsed.classification,
      parsed.message,
      parsed.status !== undefined ? { status: parsed.status } : {},
    );
  }
  const json = (await response.json()) as unknown;
  const parsed = options.parseResponse
    ? options.parseResponse(json, request)
    : defaultOpenAICompatParser(json, request);
  return {
    text: parsed.text,
    toolCalls: parsed.toolCalls ?? [],
    finishReason: parsed.finishReason ?? 'stop',
    usage: {
      inputTokens: parsed.inputTokens ?? estimateTokens(request.prompt + (request.system ?? '')),
      outputTokens: parsed.outputTokens ?? estimateTokens(parsed.text),
      totalTokens:
        parsed.totalTokens ?? estimateTokens(request.prompt + (request.system ?? '') + parsed.text),
    },
    modelId: context.model.id as ModelId,
    providerName: 'http',
    latencyMs: Date.now() - start,
    rawProviderResponse: json,
  };
}

async function* streamHttp(
  options: HttpModelOptions,
  request: CompletionRequest,
  context: ProviderCallContext,
): AsyncIterable<CompletionChunk> {
  const built = options.buildRequest
    ? options.buildRequest(request, String(context.model.id))
    : defaultOpenAICompatBuilder(request, String(context.model.id), true);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...(options.authHeader
      ? options.authHeader(context.apiKey)
      : { Authorization: `Bearer ${context.apiKey}` }),
    ...built.headers,
  };
  const url = `${options.baseUrl.replace(/\/$/, '')}${built.path.startsWith('/') ? built.path : `/${built.path}`}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(built.body),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (err: unknown) {
    throw new ProviderError(
      'http',
      String(context.model.id),
      'network',
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }
  if (!response.ok || !response.body) {
    const parsed = await parseHttpResponse(response);
    throw new ProviderError(
      'http',
      String(context.model.id),
      parsed.classification,
      parsed.message,
      parsed.status !== undefined ? { status: parsed.status } : {},
    );
  }
  if (options.parseStream) {
    const parser = options.parseStream;
    for await (const payload of readSse(response.body)) {
      yield* parser(payload, request);
    }
    return;
  }
  yield* httpStream(response.body);
}

function mapFinishReason(reason: string | undefined): FinishReason {
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

async function parseHttpResponse(response: Response): Promise<ParsedProviderError> {
  const classification = classifyStatus(response.status);
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } | string } | null;
    if (body && typeof body.error === 'object' && body.error?.message) {
      message = body.error.message;
    } else if (body && typeof body.error === 'string') {
      message = body.error;
    }
  } catch {
    // body not JSON
  }
  return retryAfterMs !== undefined
    ? { status: response.status, classification, retryAfterMs, message }
    : { status: response.status, classification, message };
}

function parseHttpError(error: unknown): ParsedProviderError {
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
