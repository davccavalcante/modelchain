/**
 * @takk/modelchain/edge - Edge runtime preset for Cloudflare Workers,
 * Vercel Edge Functions, Deno Deploy, Bun.
 *
 * Same surface as `/web` - the distinction is purely declarative; bundlers
 * use the `worker` export condition to pick this entry.
 */
export * from '../index.js';
