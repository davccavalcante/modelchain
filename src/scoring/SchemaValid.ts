import type {
  CompletionRequest,
  CompletionResponse,
  ScoringResult,
  ScoringStrategy,
} from '../types.js';

/** Minimal JSON-shape validator. Score 1.0 when parses and matches the shape. */
export interface SchemaValidShape {
  readonly required?: readonly string[];
  readonly types?: Readonly<Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>>;
}

export class SchemaValidScorer implements ScoringStrategy {
  public readonly name = 'schema-valid';
  private readonly shape: SchemaValidShape;

  public constructor(shape: SchemaValidShape = {}) {
    this.shape = shape;
  }

  public score(_request: CompletionRequest, response: CompletionResponse): ScoringResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      return { scorer: this.name, score: 0, metadata: { reason: 'not-json' } };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { scorer: this.name, score: 0, metadata: { reason: 'not-object' } };
    }
    const obj = parsed as Record<string, unknown>;
    if (this.shape.required) {
      for (const key of this.shape.required) {
        if (!(key in obj)) {
          return { scorer: this.name, score: 0, metadata: { reason: 'missing-key', key } };
        }
      }
    }
    if (this.shape.types) {
      for (const [key, expectedType] of Object.entries(this.shape.types)) {
        const value = obj[key];
        if (!matchesType(value, expectedType)) {
          return {
            scorer: this.name,
            score: 0,
            metadata: { reason: 'wrong-type', key, expectedType },
          };
        }
      }
    }
    return { scorer: this.name, score: 1, metadata: { reason: 'ok' } };
  }
}

function matchesType(
  value: unknown,
  expected: 'string' | 'number' | 'boolean' | 'object' | 'array',
): boolean {
  switch (expected) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default: {
      const exhaustive: never = expected;
      throw new Error(`Unknown type: ${String(exhaustive)}`);
    }
  }
}
