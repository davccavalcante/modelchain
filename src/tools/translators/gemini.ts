import type { ToolCall, ToolDefinition } from '../../types.js';

/** Translate `ToolDefinition[]` to the Gemini `tools` array shape. */
export function toolsToGemini(tools: readonly ToolDefinition[]): readonly object[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: {
          type: t.parameters.type,
          properties: t.parameters.properties,
          ...(t.parameters.required ? { required: [...t.parameters.required] } : {}),
        },
      })),
    },
  ];
}

/** Extract tool calls from Gemini candidate parts (functionCall blocks). */
export function toolCallsFromGemini(parts: unknown): ToolCall[] {
  if (!Array.isArray(parts)) return [];
  const results: ToolCall[] = [];
  let counter = 0;
  for (const part of parts) {
    if (typeof part !== 'object' || part === null) continue;
    const p = part as { functionCall?: { name?: string; args?: unknown } };
    const fc = p.functionCall;
    if (!fc?.name) continue;
    const args =
      fc.args && typeof fc.args === 'object' && !Array.isArray(fc.args)
        ? (fc.args as Record<string, unknown>)
        : {};
    results.push({
      id: `gemini-call-${counter}`,
      name: fc.name,
      arguments: args,
    });
    counter += 1;
  }
  return results;
}
