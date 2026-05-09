// One-shot verification: confirm every market in config/morpho.js exists on the
// live Morpho Blue singleton and its params round-trip through
// idToMarketParams(id). Run with:
//   node --env-file=.env src/scripts/verify-morpho-config.js
//
// A market that MISMATCHes (or reverts) is one MorphoBlueAdapter will drop at
// startup — fix the oracle/irm/lltv in config/morpho.js and re-run.

import 'dotenv/config';
import { createPublicClient, http, getAddress } from 'viem';
import { base } from 'viem/chains';
import { MORPHO_BASE, marketId } from '../../config/morpho.js';
import { MORPHO_ABI } from '../../config/abis/Morpho.js';

const client = createPublicClient({
  chain: base,
  transport: http(process.env.ALCHEMY_HTTP_URL),
});

console.log(`Morpho singleton: ${MORPHO_BASE.morpho}`);
console.log(`Configured markets (${MORPHO_BASE.markets.length}):\n`);

let mismatches = 0;
for (const m of MORPHO_BASE.markets) {
  const id = marketId(m);
  const idOk = id.toLowerCase() === m.id.toLowerCase();

  let live;
  try {
    live = await client.readContract({
      address: MORPHO_BASE.morpho,
      abi: MORPHO_ABI,
      functionName: 'idToMarketParams',
      args: [id],
    });
  } catch (err) {
    console.log(`  [ERROR] ${m.name} — ${err.shortMessage ?? err.message}`);
    mismatches++;
    continue;
  }

  const [loanToken, collateralToken, oracle, irm, lltv] = live;
  const exists = loanToken !== '0x0000000000000000000000000000000000000000';
  const matches = exists
    && loanToken.toLowerCase() === m.loanToken.toLowerCase()
    && collateralToken.toLowerCase() === m.collateralToken.toLowerCase()
    && oracle.toLowerCase() === m.oracle.toLowerCase()
    && irm.toLowerCase() === m.irm.toLowerCase()
    && lltv === m.lltv;

  const flag = matches && idOk ? 'OK   ' : 'BAD  ';
  if (!(matches && idOk)) mismatches++;
  console.log(`  [${flag}] ${m.name}`);
  console.log(`          id ${id}${idOk ? '' : '  <-- derived id != config id'}`);
  if (!exists) {
    console.log(`          not found on singleton (check oracle/irm/lltv)`);
  } else if (!matches) {
    console.log(`          live oracle=${getAddress(oracle)} irm=${getAddress(irm)} lltv=${lltv}`);
  }
}

console.log(`\n${mismatches === 0 ? 'All markets verified.' : `${mismatches} market(s) need attention.`}`);
process.exit(mismatches === 0 ? 0 : 1);
