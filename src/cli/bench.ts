import type { ModelchainRouter } from '../types.js';

export async function runBench(
  router: ModelchainRouter,
  options: { requests: number; prompt: string; task?: string },
): Promise<void> {
  const start = Date.now();
  let ok = 0;
  let fail = 0;
  const latencies: number[] = [];
  for (let i = 0; i < options.requests; i += 1) {
    try {
      const response = await router.complete({
        prompt: options.prompt,
        ...(options.task !== undefined ? { task: options.task } : {}),
      });
      latencies.push(response.latencyMs);
      ok += 1;
    } catch {
      fail += 1;
    }
  }
  const wallMs = Date.now() - start;
  const sortedLat = [...latencies].sort((a, b) => a - b);
  const p50 = pct(sortedLat, 0.5);
  const p95 = pct(sortedLat, 0.95);
  const p99 = pct(sortedLat, 0.99);
  const snap = router.inspect();
  process.stdout.write(
    `--- modelchain bench ---\n` +
      `requests       : ${options.requests}\n` +
      `ok             : ${ok}\n` +
      `fail           : ${fail}\n` +
      `wall time      : ${wallMs}ms\n` +
      `latency p50    : ${p50.toFixed(0)}ms\n` +
      `latency p95    : ${p95.toFixed(0)}ms\n` +
      `latency p99    : ${p99.toFixed(0)}ms\n` +
      `total cost USD : ${snap.totalCostUsd.toFixed(6)}\n` +
      `models:\n` +
      snap.models
        .map(
          (m) =>
            `  [${m.providerName}:${m.id}] req=${m.successCount + m.failureCount} ` +
            `ok=${m.successCount} fail=${m.failureCount} ` +
            `avgLat=${m.avgLatencyMs.toFixed(0)}ms ` +
            `cost=${m.totalCostUsd.toFixed(6)}`,
        )
        .join('\n') +
      '\n',
  );
}

function pct(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx] ?? 0;
}
