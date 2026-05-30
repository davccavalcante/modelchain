/**
 * Vercel Edge Function - using @takk/modelchain/edge.
 *
 * File: app/api/route/route.ts (Next.js App Router) or pages/api/route.ts.
 */
import { createModelchain } from '@takk/modelchain/edge';
import { openaiModel } from '@takk/modelchain/providers';

export const runtime = 'edge';

export async function POST(request: Request): Promise<Response> {
  const router = createModelchain({
    models: [
      openaiModel('gpt-4o-mini', {
        cost: { costPer1kInput: 0.00015, costPer1kOutput: 0.00060 },
        keys: process.env.OPENAI_API_KEY ?? '',
      }),
    ],
    budget: { perRequestUsd: 0.005 },
  });

  const { prompt } = (await request.json()) as { prompt?: string };
  if (!prompt) return Response.json({ error: 'missing prompt' }, { status: 400 });

  try {
    const response = await router.complete({ prompt, maxTokens: 200 });
    return Response.json({
      text: response.text,
      modelId: response.modelId,
      latencyMs: response.latencyMs,
      usage: response.usage,
    });
  } finally {
    await router.close();
  }
}
