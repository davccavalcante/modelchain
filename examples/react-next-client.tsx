/**
 * Next.js 15 (App Router) client component - uses @takk/modelchain/web from
 * the browser. Keys are NEVER embedded client-side: passes a keys resolver
 * that fetches a short-lived token from your own server endpoint.
 *
 * File: app/chat/page.tsx
 */
'use client';

import { useState } from 'react';
import { createModelchain } from '@takk/modelchain/web';
import { openaiModel } from '@takk/modelchain/providers';

export default function ChatPage(): JSX.Element {
  const [answer, setAnswer] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  const ask = async (prompt: string): Promise<void> => {
    setBusy(true);
    try {
      const router = createModelchain({
        models: [
          openaiModel('gpt-4o-mini', {
            cost: { costPer1kInput: 0.00015, costPer1kOutput: 0.00060 },
            keys: async () => {
              const res = await fetch('/api/short-lived-openai-token', { method: 'POST' });
              const { token } = (await res.json()) as { token: string };
              return token;
            },
          }),
        ],
        strategy: 'cost-then-quality',
        budget: { perRequestUsd: 0.01 },
      });
      let accumulated = '';
      for await (const chunk of router.stream({ prompt })) {
        if (chunk.type === 'text-delta') {
          accumulated += chunk.delta;
          setAnswer(accumulated);
        }
      }
      await router.close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <h1>Ask modelchain</h1>
      <button type="button" disabled={busy} onClick={() => void ask('Hi from React.')}>
        {busy ? 'Thinking...' : 'Ask'}
      </button>
      <pre>{answer}</pre>
    </main>
  );
}
