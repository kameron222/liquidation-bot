/**
 * CLI entry point for the liquidation bot. `npm start` runs this.
 *
 * Wires the production graph:
 *   config/config.js → viem clients → MoonwellAdapter + Executor + Notifier
 *   → PositionMonitor → start().
 *
 * SIGINT cleanly stops the loop so logs flush before exit.
 */

import 'dotenv/config';
import { promises as fs, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, http, webSocket } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import { config } from '../config/config.js';
import { MOONWELL_BASE } from '../config/moonwell.js';
import { MORPHO_BASE } from '../config/morpho.js';
import { MoonwellAdapter } from '../adapters/MoonwellAdapter.js';
import { MorphoBlueAdapter } from '../adapters/MorphoBlueAdapter.js';
import { Executor } from '../core/Executor.js';
import { PositionMonitor } from '../core/PositionMonitor.js';
import { BorrowerCache } from '../core/BorrowerCache.js';
import { TokenMetadataCache } from '../core/TokenMetadataCache.js';
import { PnlLedger } from '../core/PnlLedger.js';
import { Notifier } from '../utils/notifier.js';
import { createRotatingHttpTransport } from '../utils/rpcRotator.js';
import logger from '../utils/logger.js';

const PID_PATH = './data/bot.pid';
const BORROWER_CACHE_PATH = './data/borrowers-moonwell-base.json';
const TOKEN_META_CACHE_PATH = './data/moonwell-tokens-base.json';
const MORPHO_BORROWER_CACHE_PATH = './data/borrowers-morpho-base.json';
const PNL_LEDGER_PATH = './data/pnl.jsonl';

// Free public Base RPCs used only for `eth_getLogs` borrower discovery.
// Order matters: the rotator tries [0] first and only fails over on
// transient errors (429, 5xx, fetch/timeout). Stays sticky on whichever
// URL last succeeded.
const PUBLIC_BASE_RPCS = [
  'https://mainnet.base.org',
  'https://base.publicnode.com',
  'https://base.llamarpc.com',
];

async function ensureSingleInstance(pidPath) {
  await fs.mkdir(path.dirname(pidPath), { recursive: true });
  try {
    const raw = await fs.readFile(pidPath, 'utf8');
    const pid = Number(raw.trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        throw new Error(
          `Another bot instance is already running (PID ${pid}). ` +
          `Kill it first: kill ${pid}  (or remove ${pidPath} if stale).`,
        );
      } catch (err) {
        if (err.code === 'ESRCH') {
          // PID file points at a dead process — safe to overwrite.
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await fs.writeFile(pidPath, String(process.pid));
  const cleanup = async () => {
    try { await fs.unlink(pidPath); } catch { /* already gone */ }
  };
  process.on('exit', () => {
    try { unlinkSync(pidPath); } catch { /* ignore */ }
  });
  return cleanup;
}

async function main() {
  if (config.enableMoonwell && !config.liquidatorAddress) {
    throw new Error(
      'LIQUIDATOR_ADDRESS is not set. Deploy the Liquidator contract first:\n' +
      '  npm run deploy:liquidator\n' +
      'then copy the deployed address into .env (or set ENABLE_MOONWELL=false).',
    );
  }

  const cleanupPid = await ensureSingleInstance(PID_PATH);

  const transport = http(config.alchemyHttp);
  const publicClient = createPublicClient({ chain: base, transport });

  // Optional WS client used solely for `watchBlockNumber` to drive ticks on
  // every new head (Base's 2s cadence). Falls back to interval polling when
  // ALCHEMY_WS_URL is unset.
  const wsClient = config.alchemyWs
    ? createPublicClient({ chain: base, transport: webSocket(config.alchemyWs) })
    : null;

  // Free Alchemy plans cap eth_getLogs at 10 blocks per call. Route the
  // historical Borrow-event scan through public Base RPCs, falling over on
  // 429/5xx/timeout. Everything else (multicall, gas, balances) stays on
  // Alchemy where free-tier limits don't bite.
  const logsClient = createPublicClient({
    chain: base,
    transport: createRotatingHttpTransport(PUBLIC_BASE_RPCS),
  });

  const account = privateKeyToAccount(
    config.privateKey.startsWith('0x') ? config.privateKey : `0x${config.privateKey}`,
  );
  const walletClient = createWalletClient({ chain: base, transport, account });

  const notifier = new Notifier({ webhookUrl: config.discordWebhook });
  const executor = new Executor({
    walletClient,
    publicClient,
    maxGasGwei: config.maxGasGwei,
    priorityFeeGwei: config.priorityFeeGwei,
    dryRun: config.dryRun,
  });

  const tokenCache = new TokenMetadataCache({ path: TOKEN_META_CACHE_PATH });

  // Build the adapter graph. Each protocol is opt-out-able (ENABLE_MOONWELL /
  // ENABLE_MORPHO) and only runs when its executor address is configured, so a
  // single-protocol deploy doesn't need the other contract.
  const adapters = [];

  if (config.enableMoonwell) {
    adapters.push(new MoonwellAdapter({
      client: publicClient,
      logsClient,
      cache: new BorrowerCache({ path: BORROWER_CACHE_PATH }),
      tokenCache,
      comptroller: MOONWELL_BASE.comptroller,
      mTokens: MOONWELL_BASE.mTokens,
      deployBlock: MOONWELL_BASE.deployBlock,
      liquidatorAddress: config.liquidatorAddress,
      // ~46 days at 2s blocks. Bounds the cold-start scan; subsequent restarts
      // resume from the cache's lastScannedBlock so this only matters once.
      indexLookbackBlocks: 2_000_000n,
      // Sharded shortfall scan: 4 shards × full scan every 30 calls. With
      // block-cadence ticks (2s) every borrower is checked at least every
      // ~60s, while per-tick RPC load drops ~4×.
      shardCount: 4,
      forceFullEvery: 30,
    }));
  }

  if (config.enableMorpho) {
    if (!config.morphoLiquidatorAddress) {
      logger.warn('main.morpho disabled — MORPHO_LIQUIDATOR_ADDRESS unset', {
        hint: 'npm run deploy:morpho-liquidator, then set MORPHO_LIQUIDATOR_ADDRESS in .env',
      });
    } else {
      adapters.push(new MorphoBlueAdapter({
        client: publicClient,
        logsClient,
        cache: new BorrowerCache({ path: MORPHO_BORROWER_CACHE_PATH }),
        morpho: MORPHO_BASE.morpho,
        markets: MORPHO_BASE.markets,
        quoter: MORPHO_BASE.quoter,
        chainlinkEthUsd: MORPHO_BASE.chainlinkEthUsd,
        deployBlock: MORPHO_BASE.deployBlock,
        liquidatorAddress: config.morphoLiquidatorAddress,
        indexLookbackBlocks: 2_000_000n,
        shardCount: 4,
        forceFullEvery: 30,
      }));
    }
  }

  if (adapters.length === 0) {
    throw new Error('No adapters enabled. Set ENABLE_MOONWELL/ENABLE_MORPHO and the matching liquidator address.');
  }

  const ledger = new PnlLedger({ path: PNL_LEDGER_PATH });

  const monitor = new PositionMonitor({
    adapters,
    executor,
    notifier,
    minProfitUsd: config.minProfitUsd,
    pollIntervalMs: config.pollIntervalMs,
    evaluateConcurrency: config.evaluateConcurrency,
    wsClient,
    ledger,
  });

  const shutdown = async (signal) => {
    logger.info('main.shutdown', { signal });
    await monitor.stop();
    await cleanupPid();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('main.start', {
    account: account.address,
    adapters: adapters.map((a) => a.constructor.name),
    moonwellLiquidator: config.enableMoonwell ? config.liquidatorAddress : 'disabled',
    morphoLiquidator: config.morphoLiquidatorAddress ?? 'disabled',
  });
  await monitor.start();
}

main().catch((err) => {
  logger.error('main.fatal', { error: err?.message ?? String(err), stack: err?.stack });
  process.exit(1);
});
