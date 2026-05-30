import type { ToolCall, ToolDefinition } from '../../types.js';

/** Translate `ToolDefinition[]` to the OpenAI `tools` array shape. */
export function toolsToOpenAI(tools: readonly ToolDefinition[]): readonly object[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: t.parameters.type,
        properties: t.parameters.properties,
        ...(t.parameters.required ? { required: [...t.parameters.required] } : {}),
      },
    },
  }));
}

/** Parse OpenAI response `tool_calls` array into normalised `ToolCall[]`. */
export function toolCallsFromOpenAI(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const results: ToolCall[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as {
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    };
    if (!obj.id || !obj.function?.name) continue;
    let parsedArgs: Record<string, unknown> = {};
    if (typeof obj.function.arguments === 'string') {
      try {
        const parsed = JSON.parse(obj.function.arguments);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          parsedArgs = parsed as Record<string, unknown>;
        }
      } catch {
        // ignore malformed arguments
      }
    }
    results.push({
      id: obj.id,
      name: obj.function.name,
      arguments: parsedArgs,
    });
  }
  return results;
}
