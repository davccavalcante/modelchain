import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ModelchainRouter } from '../types.js';

/** Local HTTP proxy mode. */
export function startProxy(router: ModelchainRouter, port: number): Promise<() => Promise<void>> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handleRequest(router, req, res);
    });
    server.listen(port, () => {
      const close = () =>
        new Promise<void>((closeResolve) => {
          server.close(() => closeResolve());
        });
      resolve(close);
    });
  });
}

async function handleRequest(
  router: ModelchainRouter,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === 'GET' && req.url === '/__modelchain_inspect') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(router.inspect(), null, 2));
    return;
  }
  if (req.method === 'POST' && req.url === '/complete') {
    await handleComplete(router, req, res);
    return;
  }
  if (req.method === 'POST' && req.url === '/stream') {
    await handleStream(router, req, res);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

async function handleComplete(
  router: ModelchainRouter,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  try {
    const parsed = JSON.parse(body) as {
      prompt?: string;
      task?: string;
      system?: string;
      maxTokens?: number;
      temperature?: number;
    };
    if (typeof parsed.prompt !== 'string' || !parsed.prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid `prompt` field.' }));
      return;
    }
    const response = await router.complete({
      prompt: parsed.prompt,
      ...(parsed.task !== undefined ? { task: parsed.task } : {}),
      ...(parsed.system !== undefined ? { system: parsed.system } : {}),
      ...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
      ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        text: response.text,
        toolCalls: response.toolCalls,
        finishReason: response.finishReason,
        modelId: response.modelId,
        providerName: response.providerName,
        usage: response.usage,
        latencyMs: response.latencyMs,
      }),
    );
  } catch (err: unknown) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}

async function handleStream(
  router: ModelchainRouter,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  try {
    const parsed = JSON.parse(body) as { prompt?: string; system?: string; maxTokens?: number };
    if (typeof parsed.prompt !== 'string' || !parsed.prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid `prompt` field.' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const iterator = router.stream({
      prompt: parsed.prompt,
      ...(parsed.system !== undefined ? { system: parsed.system } : {}),
      ...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
    });
    for await (const chunk of iterator) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err: unknown) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => resolve(body));
  });
}
