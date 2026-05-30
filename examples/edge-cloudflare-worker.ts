/**
 * Cloudflare Workers - full modelchain inside an Edge runtime using
 * @takk/modelchain/edge. Zero Node built-ins, only Web Fetch + Web Streams.
 *
 * wrangler.toml:
 *   name = "my-router"
 *   compatibility_date = "2026-05-01"
 *   main = "src/worker.ts"
 *
 * Use `wrangler secret put OPENAI_API_KEY` to set the key (never inline).
 */
import { createModelchain } from '@takk/modelchain/edge';
import { openaiModel } from '@takk/modelchain/providers';

interface Env {
  readonly OPENAI_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const router = createModelchain({
      models: [
        openaiModel('gpt-4o-mini', {
          cost: { costPer1kInput: 0.00015, costPer1kOutput: 0.00060 },
          keys: env.OPENAI_API_KEY,
        }),
      ],
      budget: { perRequestUsd: 0.005 },
    });

    const { prompt } = (await request.json()) as { prompt?: string };
    if (!prompt) return new Response(JSON.stringify({ error: 'missing prompt' }), { status: 400 });

    // Stream tokens to the client via Web Streams
    if (url.pathname === '/stream') {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      (async () => {
        const encoder = new TextEncoder();
        try {
          for await (const chunk of router.stream({ prompt })) {
            await writer.write(encoder.encode(`${JSON.stringify(chunk)}\n`));
          }
        } finally {
          await writer.close();
          await router.close();
        }
      })().catch(() => {});
      return new Response(readable, {
        headers: { 'Content-Type': 'application/x-ndjson' },
      });
    }

    try {
      const response = await router.complete({ prompt, maxTokens: 200 });
      return Response.json({
        text: response.text,
        modelId: response.modelId,
        latencyMs: response.latencyMs,
        usage: response.usage,
        finishReason: response.finishReason,
      });
    } finally {
      await router.close();
    }
  },
};
