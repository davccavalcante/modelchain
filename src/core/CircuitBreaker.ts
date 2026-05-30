import type { CircuitBreakerOptions } from '../types.js';

/** Discriminated circuit state. */
export type CircuitState = 'closed' | 'half-open' | 'open';

/** Mutable state tracked per model. */
export interface CircuitBreakerState {
  state: CircuitState;
  consecutiveFailures: number;
  cooldownUntil: number;
}

/**
 * Per-model circuit breaker.
 *
 * Transitions:
 *   - `closed` -> `open`     when `consecutiveFailures` reaches `threshold`.
 *   - `open`   -> `half-open` after `cooldownMs`.
 *   - `half-open` -> `closed` on the first success after re-opening.
 *   - `half-open` -> `open`   on any failure during the probe window.
 */
export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;

  public constructor(options: CircuitBreakerOptions) {
    this.threshold = Math.max(1, options.threshold);
    this.cooldownMs = Math.max(0, options.cooldownMs);
  }

  /** Returns true when the model can accept the next request. */
  public isAvailable(state: CircuitBreakerState, now: number): boolean {
    if (state.state === 'closed') return true;
    if (state.state === 'half-open') return true;
    return now >= state.cooldownUntil;
  }

  /** Transition `open` -> `half-open` when the cooldown has elapsed. */
  public enterHalfOpen(state: CircuitBreakerState, now: number): boolean {
    if (state.state === 'open' && now >= state.cooldownUntil) {
      state.state = 'half-open';
      return true;
    }
    return false;
  }

  /** Record a success; returns true when the state transitioned. */
  public recordSuccess(state: CircuitBreakerState): boolean {
    state.consecutiveFailures = 0;
    if (state.state !== 'closed') {
      state.state = 'closed';
      state.cooldownUntil = 0;
      return true;
    }
    return false;
  }

  /** Record a failure; returns true when the state transitioned. */
  public recordFailure(state: CircuitBreakerState, now: number): boolean {
    state.consecutiveFailures += 1;
    if (state.state === 'half-open') {
      state.state = 'open';
      state.cooldownUntil = now + this.cooldownMs;
      return true;
    }
    if (state.state === 'closed' && state.consecutiveFailures >= this.threshold) {
      state.state = 'open';
      state.cooldownUntil = now + this.cooldownMs;
      return true;
    }
    return false;
  }
}
