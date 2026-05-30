import type { RetryOptions } from '../types.js';

/** Backoff calculator with optional jitter. */
export class Retrier {
  private readonly max: number;
  private readonly baseMs: number;
  private readonly jitter: boolean;
  private readonly maxDelayMs: number;

  public constructor(options: RetryOptions) {
    this.max = Math.max(0, options.max);
    this.baseMs = Math.max(0, options.baseMs);
    this.jitter = options.jitter;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
  }

  /** Returns true when another attempt is allowed for the given attempt index (0-based). */
  public shouldRetry(attemptIndex: number): boolean {
    return attemptIndex < this.max;
  }

  /** Total attempt cap. */
  public get maxAttempts(): number {
    return this.max;
  }

  /** Delay in milliseconds before the next attempt. */
  public delayMs(attemptIndex: number): number {
    const exp = this.baseMs * 2 ** attemptIndex;
    const capped = Math.min(exp, this.maxDelayMs);
    if (!this.jitter) return capped;
    return Math.random() * capped;
  }

  /** Multi-runtime sleep using globalThis primitives. */
  public sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error('aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}
