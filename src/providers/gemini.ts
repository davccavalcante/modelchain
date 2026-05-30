import { ProviderError } from '../errors.js';
import { geminiStream } from '../streaming/normalizers/gemini.js';
import { toolCallsFromGemini, toolsToGemini } from '../tools/translators/gemini.js';
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

/** Factory for a Google Gemini model definition. */
export interface GeminiModelOptions {
  readonly cost: CostProfile;
  readonly keys: ModelDefinition['keys'];
  readonly baseUrl?: string;
  readonly estimatedLatencyP50Ms?: number;
  readonly capabilities?: readonly string[];
  readonly weight?: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

export function geminiModel(modelId: string, options: GeminiModelOptions): ModelDefinition {
  const provider = createGeminiAdapter(
    options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta',
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

function createGeminiAdapter(baseUrl: string): ProviderAdapter {
  return {
    name: 'gemini',
    complete: (request, context) => callGemini(baseUrl, request, context),
    stream: (request, context) => streamGemini(baseUrl, request, context),
    parseError: parseGeminiError,
  };
}

function buildBody(request: CompletionRequest): object {
  const generationConfig: Record<string, unknown> = {};
  if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens;
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
  if (request.stopSequences && request.stopSequences.length > 0) {
    generationConfig.stopSequences = [...request.stopSequences];
  }
  return {
    contents: [{ parts: [{ text: request.prompt }] }],
    ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    ...(request.tools && request.tools.length > 0 ? { tools: toolsToGemini(request.tools) } : {}),
  };
}

async function callGemini(
  baseUrl: string,
  request: CompletionRequest,
  context: ProviderCallContext,
): Promise<CompletionResponse> {
  const start = Date.now();
  const url = `${baseUrl}/models/${encodeURIComponent(String(context.model.id))}:generateContent?key=${encodeURIComponent(context.apiKey)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(request)),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (err: unknown) {
    throw new ProviderError(
      'gemini',
      String(context.model.id),
      'network',
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }
  if (!response.ok) {
    const parsed = await parseGeminiResponse(response);
    throw new ProviderError(
      'gemini',
      String(context.model.id),
      parsed.classification,
      parsed.message,
      parsed.status !== undefined ? { status: parsed.status } : {},
    );
  }
  const json = (await response.json()) as GeminiGenerateContentResponse;
  const candidate = json.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('');
  const toolCalls = toolCallsFromGemini(parts);
  return {
    text,
    toolCalls,
    finishReason: mapFinishReason(candidate?.finishReason),
    usage: {
      inputTokens:
        json.usageMetadata?.promptTokenCount ??
        estimateTokens(request.prompt + (request.system ?? '')),
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? estimateTokens(text),
      totalTokens:
        json.usageMetadata?.totalTokenCount ??
        estimateTokens(request.prompt + (request.system ?? '') + text),
    },
    modelId: context.model.id as ModelId,
    providerName: 'gemini',
    latencyMs: Date.now() - start,
    rawProviderResponse: json,
  };
}

async function* streamGemini(
  baseUrl: string,
  request: CompletionRequest,
  context: ProviderCallContext,
): AsyncIterable<CompletionChunk> {
  const url = `${baseUrl}/models/${encodeURIComponent(String(context.model.id))}:streamGenerateContent?key=${encodeURIComponent(context.apiKey)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(request)),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (err: unknown) {
    throw new ProviderError(
      'gemini',
      String(context.model.id),
      'network',
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }
  if (!response.ok || !response.body) {
    const parsed = await parseGeminiResponse(response);
    throw new ProviderError(
      'gemini',
      String(context.model.id),
      parsed.classification,
      parsed.message,
      parsed.status !== undefined ? { status: parsed.status } : {},
    );
  }
  yield* geminiStream(response.body);
}

function mapFinishReason(reason: string | undefined): FinishReason {
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

async function parseGeminiResponse(response: Response): Promise<ParsedProviderError> {
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

function parseGeminiError(error: unknown): ParsedProviderError {
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

interface GeminiGenerateContentResponse {
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
