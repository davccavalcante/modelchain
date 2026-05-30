/**
 * Default config file consumed by `modelchain start | inspect | bench`.
 *
 * The CLI imports this module and calls its default export, expecting a
 * `ModelchainRouter` (the result of `createModelchain`).
 *
 * Usage:
 *   modelchain start   --config ./examples/modelchain.config.js --port 8788
 *   modelchain inspect --config ./examples/modelchain.config.js
 *   modelchain bench   --config ./examples/modelchain.config.js --requests 10 --prompt "Hi"
 */
import { createModelchain } from '@takk/modelchain';
import { anthropicModel, openaiModel } from '@takk/modelchain/providers';

export default function () {
  return createModelchain({
    models: [
      openaiModel('gpt-4o-mini', {
        cost: { costPer1kInput: 0.00015, costPer1kOutput: 0.00060 },
        keys: process.env.OPENAI_API_KEY ?? '',
      }),
      anthropicModel('claude-3-5-haiku-latest', {
        cost: { costPer1kInput: 0.00080, costPer1kOutput: 0.00400 },
        keys: process.env.ANTHROPIC_API_KEY ?? '',
      }),
    ],
    strategy: 'cost-then-quality',
    scoring: { built: ['latency'] },
    telemetry: { enabled: true },
  });
}
