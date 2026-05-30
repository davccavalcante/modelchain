/**
 * @takk/modelchain/providers
 *
 * Provider factories for the built-in adapters. Each factory returns a
 * `ModelDefinition` ready to be passed to `createModelchain({ models: [...] })`.
 */

export type { AnthropicModelOptions } from './anthropic.js';
export { anthropicModel } from './anthropic.js';
export type { GeminiModelOptions } from './gemini.js';
export { geminiModel } from './gemini.js';
export type { HttpModelOptions } from './http.js';
export { httpModel } from './http.js';
export type { OpenAIModelOptions } from './openai.js';
export { openaiModel } from './openai.js';
