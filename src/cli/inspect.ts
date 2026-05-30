import type { ModelchainRouter } from '../types.js';

export function printInspect(router: ModelchainRouter): void {
  const snap = router.inspect();
  const lines: string[] = [];
  lines.push('--- modelchain inspect ---');
  lines.push(`strategy        : ${snap.strategy}`);
  lines.push(`total requests  : ${snap.totalRequests}`);
  lines.push(`total streams   : ${snap.totalStreams}`);
  lines.push(`total failures  : ${snap.totalFailures}`);
  lines.push(`total cost USD  : ${snap.totalCostUsd.toFixed(6)}`);
  lines.push(`budget          :`);
  lines.push(`  perRequestUsd : ${snap.budget.perRequestUsd ?? 'unset'}`);
  lines.push(`  dailyUsd      : ${snap.budget.dailyUsd ?? 'unset'}`);
  lines.push(`  spentTodayUsd : ${snap.budget.spentTodayUsd.toFixed(6)}`);
  lines.push('models:');
  for (const m of snap.models) {
    lines.push(
      `  [${m.providerName}:${m.id}] state=${m.circuitState} health=${m.healthScore.toFixed(1)} ` +
        `req=${m.successCount + m.failureCount} ok=${m.successCount} fail=${m.failureCount} ` +
        `avgLat=${m.avgLatencyMs.toFixed(0)}ms ` +
        `avgQ=${m.avgQualityScore === null ? 'n/a' : m.avgQualityScore.toFixed(3)} ` +
        `cost=${m.totalCostUsd.toFixed(6)}`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}
