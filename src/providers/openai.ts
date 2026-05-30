import { ProviderError } from '../errors.js';
import { openAIStream } from '../streaming/normalizers/openai.js';
import { toolCallsFromOpenAI, toolsToOpenAI } from '../tools/translators/openai.js';
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

/** Factory for an OpenAI chat-completions model definition. */
export interface OpenAIModelOptions {
  readonly cost: CostProfile;
  readonly keys: ModelDefinition['keys'];
  readonly baseUrl?: string;
  readonly estimatedLatencyP50Ms?: number;
  readonly capabilities?: readonly string[];
  readonly weight?: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

export function openaiModel(modelId: string, options: OpenAIModelOptions): ModelDefinition {
  const provider = createOpenAIAdapter(options.baseUrl ?? 'https://api.openai.com/v1');
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

function createOpenAIAdapter(baseUrl: string): ProviderAdapter {
  return {
    name: 'openai',
    complete: (request, context) => callOpenAI(baseUrl, request, context, false),
    stream: (request, context) => streamOpenAI(baseUrl, request, context),
    parseError: parseOpenAIError,
  };
}

function buildBody(request: CompletionRequest, modelId: string, stream: boolean): object {
  const messages: Array<{ role: string; content: string }> = [];
  if (request.system) messages.push({ role: 'system', content: request.system });
  messages.push({ role: 'user', content: request.prompt });
  return {
    model: modelId,
    messages,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.stopSequences && request.stopSequences.length > 0
      ? { stop: [...request.stopSequences] }
      : {}),
    ...(request.tools && request.tools.length > 0 ? { tools: toolsToOpenAI(request.tools) } : {}),
  };
}

async function callOpenAI(
  baseUrl: string,
  request: CompletionRequest,
  context: ProviderCallContext,
  _stream: boolean,
): Promise<CompletionResponse> {
  const start = Date.now();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${context.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildBody(request, String(context.model.id), false)),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (err: unknown) {
    throw new ProviderError(
      'openai',
      String(context.model.id),
      'network',
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }
  if (!response.ok) {
    const parsed = await parseOpenAIResponse(response);
    throw new ProviderError(
      'openai',
      String(context.model.id),
      parsed.classification,
      parsed.message,
      parsed.status !== undefined ? { status: parsed.status } : {},
    );
  }
  const json = (await response.json()) as OpenAIChatCompletionResponse;
  const choice = json.choices[0];
  const text = choice?.message?.content ?? '';
  const toolCalls = toolCallsFromOpenAI(choice?.message?.tool_calls);
  return {
    text,
    toolCalls,
    finishReason: mapFinishReason(choice?.finish_reason),
    usage: {
      inputTokens:
        json.usage?.prompt_tokens ?? estimateTokens(request.prompt + (request.system ?? '')),
      outputTokens: json.usage?.completion_tokens ?? estimateTokens(text),
      totalTokens:
        json.usage?.total_tokens ?? estimateTokens(request.prompt + (request.system ?? '') + text),
    },
    modelId: context.model.id as ModelId,
    providerName: 'openai',
    latencyMs: Date.now() - start,
    rawProviderResponse: json,
  };
}

async function* streamOpenAI(
  baseUrl: string,
  request: CompletionRequest,
  context: ProviderCallContext,
): AsyncIterable<CompletionChunk> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${context.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(buildBody(request, String(context.model.id), true)),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (err: unknown) {
    throw new ProviderError(
      'openai',
      String(context.model.id),
      'network',
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }
  if (!response.ok || !response.body) {
    const parsed = await parseOpenAIResponse(response);
    throw new ProviderError(
      'openai',
      String(context.model.id),
      parsed.classification,
      parsed.message,
      parsed.status !== undefined ? { status: parsed.status } : {},
    );
  }
  yield* openAIStream(response.body);
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

async function parseOpenAIResponse(response: Response): Promise<ParsedProviderError> {
  const classification = classifyStatus(response.status);
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

function parseOpenAIError(error: unknown): ParsedProviderError {
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

interface OpenAIChatCompletionResponse {
  readonly choices: ReadonlyArray<{
    readonly message?: {
      readonly content?: string;
      readonly tool_calls?: unknown;
    };
    readonly finish_reason?: string;
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
}
