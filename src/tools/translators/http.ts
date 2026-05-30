import type { ToolCall, ToolDefinition } from '../../types.js';
import { toolCallsFromOpenAI, toolsToOpenAI } from './openai.js';

/** Default translation for OpenAI-compatible HTTP endpoints. */
export function toolsToHttp(tools: readonly ToolDefinition[]): readonly object[] {
  return toolsToOpenAI(tools);
}

export function toolCallsFromHttp(raw: unknown): ToolCall[] {
  return toolCallsFromOpenAI(raw);
}
