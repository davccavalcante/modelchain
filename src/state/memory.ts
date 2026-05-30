import type { StateBackend, StateSnapshot } from '../types.js';

/** In-memory state backend (default). No persistence, no cross-process sharing. */
export class MemoryStateBackend implements StateBackend {
  public readonly name = 'memory';
  private snapshot: StateSnapshot | null = null;

  public load(): Promise<StateSnapshot | null> {
    return Promise.resolve(this.snapshot);
  }

  public save(snapshot: StateSnapshot): Promise<void> {
    this.snapshot = snapshot;
    return Promise.resolve();
  }
}
