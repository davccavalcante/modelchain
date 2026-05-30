import { describe, expect, it } from 'vitest';
import { toolCallsFromAnthropic, toolsToAnthropic } from '../../src/tools/translators/anthropic.js';
import { toolCallsFromGemini, toolsToGemini } from '../../src/tools/translators/gemini.js';
import { toolCallsFromHttp, toolsToHttp } from '../../src/tools/translators/http.js';
import { toolCallsFromOpenAI, toolsToOpenAI } from '../../src/tools/translators/openai.js';
import type { ToolDefinition } from '../../src/types.js';

const weatherTool: ToolDefinition = {
  name: 'get_weather',
  description: 'Get the weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
};

describe('openai translator', () => {
  it('produces function-typed entries', () => {
    const out = toolsToOpenAI([weatherTool]);
    expect(out).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the weather for a city.',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string', description: 'City name' } },
            required: ['city'],
          },
        },
      },
    ]);
  });

  it('parses tool_calls into normalised ToolCall[]', () => {
    const calls = toolCallsFromOpenAI([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
      },
    ]);
    expect(calls).toEqual([{ id: 'call_1', name: 'get_weather', arguments: { city: 'Tokyo' } }]);
  });

  it('returns [] on non-array input', () => {
    expect(toolCallsFromOpenAI(undefined)).toEqual([]);
    expect(toolCallsFromOpenAI('nonsense')).toEqual([]);
  });

  it('ignores malformed arguments JSON', () => {
    const calls = toolCallsFromOpenAI([
      { id: 'call_1', type: 'function', function: { name: 'x', arguments: '{not-json' } },
    ]);
    expect(calls).toEqual([{ id: 'call_1', name: 'x', arguments: {} }]);
  });
});

describe('anthropic translator', () => {
  it('produces input_schema shape', () => {
    const out = toolsToAnthropic([weatherTool]);
    expect(out).toEqual([
      {
        name: 'get_weather',
        description: 'Get the weather for a city.',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      },
    ]);
  });

  it('parses tool_use blocks from content', () => {
    const calls = toolCallsFromAnthropic([
      { type: 'text', text: 'thinking...' },
      { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Tokyo' } },
    ]);
    expect(calls).toEqual([{ id: 'tu_1', name: 'get_weather', arguments: { city: 'Tokyo' } }]);
  });

  it('returns [] for invalid content', () => {
    expect(toolCallsFromAnthropic('nope')).toEqual([]);
  });
});

describe('gemini translator', () => {
  it('produces functionDeclarations shape', () => {
    const out = toolsToGemini([weatherTool]);
    expect(out).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get the weather for a city.',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string', description: 'City name' } },
              required: ['city'],
            },
          },
        ],
      },
    ]);
  });

  it('extracts functionCall parts', () => {
    const calls = toolCallsFromGemini([
      { text: 'thinking' },
      { functionCall: { name: 'get_weather', args: { city: 'Tokyo' } } },
    ]);
    expect(calls).toEqual([
      { id: 'gemini-call-0', name: 'get_weather', arguments: { city: 'Tokyo' } },
    ]);
  });
});

describe('http translator (OpenAI-compatible default)', () => {
  it('matches the OpenAI shape', () => {
    expect(toolsToHttp([weatherTool])).toEqual(toolsToOpenAI([weatherTool]));
  });
  it('parses the same shape as OpenAI', () => {
    expect(
      toolCallsFromHttp([{ id: 'c', type: 'function', function: { name: 'n', arguments: '{}' } }]),
    ).toEqual([{ id: 'c', name: 'n', arguments: {} }]);
  });
});
