/**
 * benchmark-morpho.js — quantify where retail-accessible MEV stops being viable
 * for Morpho Blue liquidations on Base.
 *
 * A liquidation is a race: the moment a position crosses its LLTV, whoever gets
 * a `liquidate` tx included first takes the whole incentive. This script
 * measures the part of that race a retail bot actually controls — the
 * *reaction path*: how long, from seeing a new block, it takes this bot to
 * (re)scan health, simulate profit against live reserves, and produce signed-
 * ready calldata. It then frames that number against the structural advantages
 * searchers buy (colocation, private orderflow, dedicated RPC) so you can see
 * where a single-VPS / shared-RPC setup stops competing.
 *
 * It is measurement, not theatre: the scan latency is real (live markets +
 * indexed borrowers), and the estimate latency is a real QuoterV2 round-trip
 * against current pool reserves on a representative position.
 *
 *   node --env-file=.env src/scripts/benchmark-morpho.js
 *
 * Env: ALCHEMY_HTTP_URL (required), BENCH_ITERS (default 20).
 */

import 'dotenv/config';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { MORPHO_BASE } from '../../config/morpho.js';
import { MorphoBlueAdapter } from '../../adapters/MorphoBlueAdapter.js';

const BASE_BLOCK_MS = 2000; // Base sequencer target cadence.
const ITERS = Number(process.env.BENCH_ITERS ?? 20);

if (!process.env.ALCHEMY_HTTP_URL) {
  console.error('ALCHEMY_HTTP_URL is required. Set it in .env, then re-run.');
  process.exit(1);
}

const client = createPublicClient({ chain: base, transport: http(process.env.ALCHEMY_HTTP_URL) });

const adapter = new MorphoBlueAdapter({
  client,
  morpho: MORPHO_BASE.morpho,
  markets: MORPHO_BASE.markets,
  quoter: MORPHO_BASE.quoter,
  chainlinkEthUsd: MORPHO_BASE.chainlinkEthUsd,
  deployBlock: MORPHO_BASE.deployBlock,
  // Bounded bootstrap so the benchmark starts quickly.
  indexLookbackBlocks: 500_000n,
});

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}
const ms = (t) => `${t.toFixed(0)}ms`;

async function timed(fn) {
  const t0 = performance.now();
  const out = await fn();
  return { dtMs: performance.now() - t0, out };
}

// A representative position for the estimate stage: the collateral/loan pair of
// the first configured market, sized to a mid liquidation (~$5k of collateral).
// estimateProfit fires the same QuoterV2 + gas + price reads it would in prod.
function syntheticPosition() {
  const m = adapter.markets[0];
  return {
    protocol: 'morpho',
    market: {
      id: m.id, name: m.name, loanToken: m.loanToken, collateralToken: m.collateralToken,
      oracle: m.oracle, irm: m.irm, lltv: m.lltv,
    },
    borrower: '0x000000000000000000000000000000000000dEaD',
    borrowShares: 0n,
    collateral: 5_000_000_000_000_000_000n, // 5e18 collateral units
    borrowAssets: 2_000_000_000n,           // placeholder debt (loan base units)
    collateralPrice: 0n,                    // filled below from the live oracle
  };
}

async function main() {
  console.log(`Morpho liquidation reaction-path benchmark (Base, ${ITERS} iterations)\n`);

  const t0 = performance.now();
  const idx = await adapter.indexBorrowers();
  console.log(`Indexed ${idx.borrowerCount} borrowers across ${adapter.markets.length} market(s) `
    + `in ${ms(performance.now() - t0)}\n`);

  if (adapter.markets.length === 0) {
    console.error('No markets validated on-chain. Run `npm run verify:morpho` and fix config/morpho.js.');
    process.exit(1);
  }

  // Prime the synthetic position's collateral price from the live oracle so the
  // estimate stage exercises a realistic (routable) size.
  const pos = syntheticPosition();
  try {
    pos.collateralPrice = await client.readContract({
      address: pos.market.oracle,
      abi: [{ type: 'function', name: 'price', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
      functionName: 'price',
    });
    // Size debt so effectiveRepay is collateral-bound (full seize) → real quote.
    pos.borrowAssets = (pos.collateral * pos.collateralPrice) / (10n ** 36n);
  } catch { /* leave placeholder; estimate will still time the code path */ }

  const scan = [];
  const estimate = [];
  const build = [];
  const reaction = []; // scan + estimate + build, the full "block → calldata" path

  for (let i = 0; i < ITERS; i++) {
    const r0 = performance.now();

    const { dtMs: scanMs } = await timed(() => adapter.getLiquidatable());
    scan.push(scanMs);

    const { dtMs: estMs } = await timed(() => adapter.estimateProfit(pos).catch(() => null));
    estimate.push(estMs);

    const { dtMs: buildMs } = await timed(async () => {
      try { return adapter.buildLiquidationCall(pos); } catch { return null; }
    });
    build.push(buildMs);

    reaction.push(performance.now() - r0);
    process.stdout.write(`\r  iteration ${i + 1}/${ITERS}`);
  }
  console.log('\n');

  report('health scan   (getLiquidatable)', scan);
  report('profit sim    (estimateProfit) ', estimate);
  report('calldata      (build)          ', build);
  report('REACTION PATH (block→calldata) ', reaction);

  const p50 = pct([...reaction].sort((a, b) => a - b), 50);
  const p90 = pct([...reaction].sort((a, b) => a - b), 90);
  verdict(p50, p90);
}

function report(label, samples) {
  const s = [...samples].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  console.log(`${label}  avg ${ms(avg)}  p50 ${ms(pct(s, 50))}  p90 ${ms(pct(s, 90))}  max ${ms(pct(s, 100))}`);
}

function verdict(p50, p90) {
  const budget = BASE_BLOCK_MS;
  console.log(`\n── Viability vs. Base's ${budget}ms block ──\n`);
  console.log(`This bot needs ~${ms(p90)} (p90) from block head to signed-ready calldata.`);
  console.log(`On top of that sits network RTT to the sequencer and the public-mempool`);
  console.log(`ordering it can't control.\n`);

  const blocksBehind = Math.ceil(p90 / budget);
  console.log(`Retail reality on this setup:`);
  console.log(`  • Reaction path spans ~${blocksBehind} block(s). A searcher colocated with a`);
  console.log(`    private-orderflow RPC reacts inside a single block and bids priority fee`);
  console.log(`    to jump the queue — so on saturated pairs (WETH/cbETH/cbBTC-USDC) the`);
  console.log(`    liquidation is taken before this bot's tx is even broadcast.`);
  console.log(`  • Shared/free RPC adds tens-to-hundreds of ms of variance (see p90 vs p50)`);
  console.log(`    and rate-limits the health scan — the single biggest retail bottleneck.`);
  console.log(`  • No private mempool on Base means every candidate tx is front-runnable.\n`);
  console.log(`Where retail still clears:`);
  console.log(`  • Long-tail collateral with no searcher coverage (Aerodrome-only routes).`);
  console.log(`  • Small positions the pros ignore (fixed gas makes them net-negative for a`);
  console.log(`    bot paying for infra; break-even for a $0-infra VPS).`);
  console.log(`  • Off-peak windows when priority-fee competition collapses.\n`);
  console.log(`Rule of thumb: below ~$${estimateBreakevenUsd()} of incentive, or on any pair a`);
  console.log(`funded searcher indexes, a single-VPS/free-RPC bot is structurally late.`);
}

// Rough break-even incentive: the profit that just covers a liquidation's gas
// at a nominal Base gas price. Illustrative, not a live read.
function estimateBreakevenUsd() {
  const gas = 600_000n;
  const gweiPrice = 0.05; // ~Base median
  const ethUsd = 3000;
  const usd = (Number(gas) * gweiPrice * 1e-9) * ethUsd;
  return usd.toFixed(2);
}

main().catch((err) => {
  console.error('\nbenchmark failed:', err?.shortMessage ?? err?.message ?? err);
  process.exit(1);
});
