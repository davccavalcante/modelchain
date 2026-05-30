import type { TelemetryEvent, TelemetryListener } from '../types.js';

/**
 * In-process event bus for router events.
 *
 * Multi-runtime safe: zero Node built-ins, zero external deps. Listeners are
 * called synchronously in registration order; an exception in one listener
 * does NOT prevent the others from running and does NOT abort the request.
 */
export class Telemetry {
  private readonly listeners = new Set<TelemetryListener>();
  private readonly enabled: boolean;

  public constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /** Register a listener. Returns an unsubscribe function. */
  public on(listener: TelemetryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Emit an event to all subscribers. No-op when telemetry is disabled. */
  public emit(event: TelemetryEvent): void {
    if (!this.enabled) return;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener crashes never propagate. The router's own logging would
        // create circular telemetry, so we intentionally swallow here.
      }
    }
  }

  /** Drop all listeners. Called by `router.close()`. */
  public dispose(): void {
    this.listeners.clear();
  }
}
