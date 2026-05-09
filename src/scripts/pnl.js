#!/usr/bin/env node
/**
 * Print a 24h roll-up of `data/pnl.jsonl`.
 *
 *   npm run pnl              # last 24h
 *   npm run pnl -- 168       # last 168h (1 week)
 *
 * Reads only — never writes. Safe to run while the bot is live.
 */

import { PnlLedger } from '../../core/PnlLedger.js';

const HOURS = Number(process.argv[2] ?? 24);
if (!Number.isFinite(HOURS) || HOURS <= 0) {
  console.error(`Invalid hours arg: ${process.argv[2]}`);
  process.exit(1);
}

const ledger = new PnlLedger({ path: './data/pnl.jsonl' });
const since = Date.now() - HOURS * 3600 * 1000;
const summary = await ledger.summarise(since);

console.log(`Liquidation PnL — last ${HOURS}h`);
console.log('─'.repeat(40));
console.log(`attempts:        ${summary.total}`);
for (const [status, n] of Object.entries(summary.byStatus)) {
  console.log(`  ${status.padEnd(15)} ${n}`);
}
console.log(`est net (sum):    $${summary.estNetUsd.toFixed(2)}`);
console.log(`actual gas (sum): $${summary.actualGasUsd.toFixed(2)}`);
console.log(`actual net (sum): $${summary.actualNetUsd.toFixed(2)}`);
