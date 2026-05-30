import type { ToolCall, ToolDefinition } from '../../types.js';

/** Translate `ToolDefinition[]` to the Anthropic `tools` array shape. */
export function toolsToAnthropic(tools: readonly ToolDefinition[]): readonly object[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: t.parameters.type,
      properties: t.parameters.properties,
      ...(t.parameters.required ? { required: [...t.parameters.required] } : {}),
    },
  }));
}

/** Extract tool calls from Anthropic message content blocks. */
export function toolCallsFromAnthropic(content: unknown): ToolCall[] {
  if (!Array.isArray(content)) return [];
  const results: ToolCall[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: string; id?: string; name?: string; input?: unknown };
    if (b.type !== 'tool_use' || !b.id || !b.name) continue;
    const args =
      b.input && typeof b.input === 'object' && !Array.isArray(b.input)
        ? (b.input as Record<string, unknown>)
        : {};
    results.push({
      id: b.id,
      name: b.name,
      arguments: args,
    });
  }
  return results;
}
