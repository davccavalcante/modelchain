import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StateBackend, StateSnapshot } from '../types.js';

/**
 * File-backed state - JSON document at the given path.
 *
 * Node-only. The file contains ONLY aggregated metadata (health scores,
 * latency averages, success counts, costs). It NEVER contains raw API keys,
 * raw prompts, or raw responses.
 */
export class FileStateBackend implements StateBackend {
  public readonly name = 'file';
  private readonly path: string;

  public constructor(path: string) {
    this.path = path;
  }

  public async load(): Promise<StateSnapshot | null> {
    try {
      const data = await readFile(this.path, 'utf-8');
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const obj = parsed as Partial<StateSnapshot>;
      if (
        obj.models &&
        typeof obj.models === 'object' &&
        typeof obj.spentTodayUsd === 'number' &&
        typeof obj.day === 'string'
      ) {
        return obj as StateSnapshot;
      }
      return null;
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as { code: unknown }).code === 'ENOENT') {
        return null;
      }
      return null;
    }
  }

  public async save(snapshot: StateSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(snapshot, null, 2), 'utf-8');
  }
}
