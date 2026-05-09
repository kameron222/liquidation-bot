// One-shot verification: compare config/moonwell.js mTokens against what
// Comptroller.getAllMarkets() returns on Base mainnet. Run with:
//   node --env-file=.env src/scripts/verify-moonwell-config.js

import 'dotenv/config';
import { createPublicClient, http, getAddress } from 'viem';
import { base } from 'viem/chains';
import { MOONWELL_BASE } from '../../config/moonwell.js';

const COMPTROLLER_ABI = [{
  type: 'function',
  name: 'getAllMarkets',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'address[]' }],
}];

const MTOKEN_ABI = [{
  type: 'function',
  name: 'symbol',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'string' }],
}];

const client = createPublicClient({
  chain: base,
  transport: http(process.env.ALCHEMY_HTTP_URL),
});

const live = await client.readContract({
  address: MOONWELL_BASE.comptroller,
  abi: COMPTROLLER_ABI,
  functionName: 'getAllMarkets',
});

const liveWithSymbols = await Promise.all(live.map(async (addr) => {
  let symbol = '?';
  try {
    symbol = await client.readContract({ address: addr, abi: MTOKEN_ABI, functionName: 'symbol' });
  } catch {}
  return { symbol, address: getAddress(addr) };
}));

const liveSet = new Set(live.map((a) => a.toLowerCase()));
const cfgSet = new Set(MOONWELL_BASE.mTokens.map((m) => m.address.toLowerCase()));

console.log(`Comptroller: ${MOONWELL_BASE.comptroller}`);
console.log(`Live markets (${liveWithSymbols.length}):`);
for (const { symbol, address } of liveWithSymbols) {
  const flag = cfgSet.has(address.toLowerCase()) ? 'OK ' : 'NEW';
  console.log(`  [${flag}] ${symbol.padEnd(10)} ${address}`);
}

const stale = MOONWELL_BASE.mTokens.filter((m) => !liveSet.has(m.address.toLowerCase()));
if (stale.length) {
  console.log(`\nStale entries in config (not in live):`);
  for (const m of stale) console.log(`  [STALE] ${m.symbol.padEnd(10)} ${m.address}`);
} else {
  console.log(`\nNo stale entries in config.`);
}
