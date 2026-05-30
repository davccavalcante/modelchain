<!--
  Vue 3 single-file component using @takk/modelchain/web with streaming.
  Same browser-safety rule as React: never embed a raw API key.
-->
<script setup lang="ts">
import { ref } from 'vue';
import { createModelchain } from '@takk/modelchain/web';
import { openaiModel } from '@takk/modelchain/providers';

const answer = ref<string>('');
const busy = ref<boolean>(false);

async function ask(prompt: string): Promise<void> {
  busy.value = true;
  try {
    const router = createModelchain({
      models: [
        openaiModel('gpt-4o-mini', {
          cost: { costPer1kInput: 0.00015, costPer1kOutput: 0.00060 },
          keys: async () => {
            const res = await fetch('/api/short-lived-openai-token', { method: 'POST' });
            const data = (await res.json()) as { token: string };
            return data.token;
          },
        }),
      ],
      budget: { perRequestUsd: 0.01 },
    });
    let accumulated = '';
    for await (const chunk of router.stream({ prompt })) {
      if (chunk.type === 'text-delta') {
        accumulated += chunk.delta;
        answer.value = accumulated;
      }
    }
    await router.close();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main>
    <h1>Ask modelchain</h1>
    <button type="button" :disabled="busy" @click="ask('Hi from Vue.')">
      {{ busy ? 'Thinking...' : 'Ask' }}
    </button>
    <pre>{{ answer }}</pre>
  </main>
</template>
