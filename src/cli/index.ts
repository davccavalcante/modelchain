/**
 * modelchain CLI bootstrap.
 *
 * Subcommands:
 *   modelchain start    --port 8788 [--config ./modelchain.config.js]
 *   modelchain inspect  [--config ./modelchain.config.js]
 *   modelchain bench    [--requests 10] [--prompt "..."] [--config ./mc.config.js]
 *
 * The `--config` file must default-export a function returning a `ModelchainRouter`.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelchainRouter } from '../types.js';
import { parseArgs } from './args.js';
import { runBench } from './bench.js';
import { printInspect } from './inspect.js';
import { startProxy } from './server.js';

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.command || parsed.command === 'help' || parsed.flags.help === true) {
    printUsage();
    return;
  }
  const router = await loadRouterFromConfig(parsed.flags.config ?? './modelchain.config.js');
  switch (parsed.command) {
    case 'start': {
      const port = Number(parsed.flags.port ?? 8788);
      if (Number.isNaN(port) || port <= 0) {
        process.stderr.write(`Invalid --port: ${String(parsed.flags.port)}\n`);
        process.exit(1);
      }
      const close = await startProxy(router, port);
      process.stdout.write(`modelchain proxy listening on http://localhost:${port}\n`);
      const onSignal = async () => {
        await close();
        await router.close();
        process.exit(0);
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      return;
    }
    case 'inspect': {
      printInspect(router);
      await router.close();
      return;
    }
    case 'bench': {
      const requests = Number(parsed.flags.requests ?? 5);
      const prompt =
        typeof parsed.flags.prompt === 'string' ? parsed.flags.prompt : 'Say hello in 5 words.';
      const task = typeof parsed.flags.task === 'string' ? parsed.flags.task : undefined;
      await runBench(router, {
        requests,
        prompt,
        ...(task !== undefined ? { task } : {}),
      });
      await router.close();
      return;
    }
    default: {
      process.stderr.write(`Unknown command: ${parsed.command}\n`);
      printUsage();
      process.exit(1);
    }
  }
}

async function loadRouterFromConfig(configPath: string | boolean): Promise<ModelchainRouter> {
  if (typeof configPath !== 'string') {
    throw new Error('Invalid --config path');
  }
  const abs = resolve(process.cwd(), configPath);
  const mod: unknown = await import(pathToFileURL(abs).href);
  const factory =
    (mod && typeof mod === 'object' && 'default' in mod
      ? (mod as { default: unknown }).default
      : mod) ?? null;
  if (typeof factory !== 'function') {
    throw new Error(
      `Config at ${abs} must default-export a function returning a ModelchainRouter.`,
    );
  }
  const router = await (factory as () => ModelchainRouter | Promise<ModelchainRouter>)();
  return router;
}

function printUsage(): void {
  process.stdout.write(
    `modelchain - universal, drop-in, measurable LLM router\n` +
      `\n` +
      `Usage:\n` +
      `  modelchain start   [--port 8788] [--config ./modelchain.config.js]\n` +
      `  modelchain inspect [--config ./modelchain.config.js]\n` +
      `  modelchain bench   [--requests 10] [--prompt "..."] [--task summarisation]\n` +
      `\n` +
      `The --config file must default-export a function returning a ModelchainRouter\n` +
      `(i.e. the result of createModelchain({...})).\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
