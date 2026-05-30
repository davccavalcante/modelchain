/**
 * @takk/modelchain/web - Browser-safe subset.
 *
 * Excludes the `FileStateBackend` (needs `node:fs`) and the CLI bootstrap.
 * Includes everything else, including streaming and tool calling.
 *
 * Security note: never embed a raw API key in client-side code. Pass a
 * `keys: async () => fetchSecret(...)` function that calls your own server
 * endpoint, which mints a short-lived per-user token.
 */
export * from '../index.js';
