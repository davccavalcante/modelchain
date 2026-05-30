import { ProviderError } from '../errors.js';
import type { KeySource, ParsedProviderError, ProviderErrorClass } from '../types.js';

/**
 * Resolve a `KeySource` to a single key value for the next call.
 *
 * Accepts only:
 *   - `string` (raw key),
 *   - `() => string | Promise<string>` (resolver function).
 *
 * To rotate, wrap your rotation library in a resolver function. Modelchain has
 * no opinion about how the key is produced.
 */
export async function resolveKey(source: KeySource): Promise<string> {
  if (typeof source === 'string') {
    if (!source) {
      throw new ProviderError('shared', 'unknown', 'unauthorized', 'Key string is empty');
    }
    return source;
  }
  if (typeof source === 'function') {
    const result = source();
    const value = result instanceof Promise ? await result : result;
    if (typeof value !== 'string' || !value) {
      throw new ProviderError(
        'shared',
        'unknown',
        'unauthorized',
        'Key resolver returned an empty value',
      );
    }
    return value;
  }
  const exhaustive: never = source;
  throw new ProviderError(
    'shared',
    'unknown',
    'unauthorized',
    `Unsupported key source: ${String(exhaustive)}`,
  );
}

/** Classify an HTTP status code into the canonical provider error class. */
export function classifyStatus(status: number | undefined): ProviderErrorClass {
  if (status === undefined) return 'network';
  if (status === 408 || status === 425) return 'timeout';
  if (status === 429) return 'rate-limited';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status >= 400 && status < 500) return 'bad-request';
  if (status >= 500 && status < 600) return 'server-error';
  return 'unknown';
}

/** Parse `Retry-After` header value (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const date = new Date(header);
  const time = date.getTime();
  if (Number.isNaN(time)) return undefined;
  return Math.max(0, time - Date.now());
}

/** Build a `ParsedProviderError` from a fetch `Response`. */
export async function parsedFromResponse(response: Response): Promise<ParsedProviderError> {
  const classification = classifyStatus(response.status);
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  let body = '';
  try {
    body = await response.text();
  } catch {
    // ignore
  }
  const message = body.slice(0, 500) || `HTTP ${response.status}`;
  return retryAfterMs !== undefined
    ? { status: response.status, classification, retryAfterMs, message }
    : { status: response.status, classification, message };
}

/** Crude character-based token estimate when the provider response omits usage info. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
