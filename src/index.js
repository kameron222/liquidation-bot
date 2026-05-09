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
import { MoonwellAdapter } from '../adapters/MoonwellAdapter.js';
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
  if (!config.liquidatorAddress) {
    throw new Error(
      'LIQUIDATOR_ADDRESS is not set. Deploy the Liquidator contract first:\n' +
      '  npm run deploy:liquidator\n' +
      'then copy the deployed address into .env.',
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

  const borrowerCache = new BorrowerCache({ path: BORROWER_CACHE_PATH });
  const tokenCache = new TokenMetadataCache({ path: TOKEN_META_CACHE_PATH });

  const adapter = new MoonwellAdapter({
    client: publicClient,
    logsClient,
    cache: borrowerCache,
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
  });

  const ledger = new PnlLedger({ path: PNL_LEDGER_PATH });

  const monitor = new PositionMonitor({
    adapters: [adapter],
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
    liquidator: config.liquidatorAddress,
  });
  await monitor.start();
}

main().catch((err) => {
  logger.error('main.fatal', { error: err?.message ?? String(err), stack: err?.stack });
  process.exit(1);
});
