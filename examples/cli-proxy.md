# CLI proxy mode

Run modelchain as a local HTTP proxy so any client (curl, your editor, an agent runtime, an internal microservice) can route prompts through your model pool without embedding the SDK.

## Start the proxy

```bash
cat > modelchain.config.js <<'EOF'
import { createModelchain } from '@takk/modelchain';
import { openaiModel } from '@takk/modelchain/providers';

export default function () {
  return createModelchain({
    models: [
      openaiModel('gpt-4o-mini', {
        cost: { costPer1kInput: 0.00015, costPer1kOutput: 0.00060 },
        keys: process.env.OPENAI_API_KEY ?? '',
      }),
    ],
    strategy: 'cost-first',
  });
}
EOF

npx @takk/modelchain start
# modelchain proxy listening on http://localhost:8788
```

## Non-streaming completion

```bash
curl -X POST http://localhost:8788/complete \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Hello in 5 words.","task":"greeting"}'
```

## Streaming completion (newline-delimited JSON of CompletionChunks)

```bash
curl -X POST http://localhost:8788/stream \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Tell me a 30-word story."}'
```

The server emits Server-Sent Events with each chunk as `data: <json>`. A final `data: [DONE]` indicates the stream finished.

## Inspect live router state

```bash
curl http://localhost:8788/__modelchain_inspect | jq
```

## One-shot bench

```bash
npx @takk/modelchain bench --requests 10 --prompt "Summarise: AI is text in, text out."
```
