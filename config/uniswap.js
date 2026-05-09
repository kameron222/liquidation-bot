/**
 * Uniswap V3 + canonical token addresses on Base mainnet.
 *
 * `swapRouter02` is the V3 router used by Liquidator.sol's executeOperation
 * callback to swap seized collateral back into the borrowed asset.
 *
 * Path encoding (V3): tightly packed `(address, uint24, address, uint24, ...)`,
 * one (fee, tokenOut) hop per pool. Single-hop example:
 *   abi.encodePacked(WETH, uint24(500), USDC)
 *
 * Source: Uniswap deployments page,
 *   https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments
 */

import { isAddress } from 'viem';

export const UNISWAP_BASE = {
  swapRouter02: '0x2626664c2603336E57B271c5C0b26F421741e481',
};

export const TOKENS_BASE = {
  WETH:    '0x4200000000000000000000000000000000000006',
  USDC:    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDbC:   '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
  cbETH:   '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
  cbBTC:   '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  DAI:     '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
  AERO:    '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
  weETH:   '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A',
  wstETH:  '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452',
  rETH:    '0xB6fE221Fe9EeF5aBa221c348bA20A1Bf5e73624c',
  EURC:    '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
  USDS:    '0x820C137fA70C8691f0e44Dc420a5e53c168921Dc',
  tBTC:    '0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b',
  LBTC:    '0xecAc9C5F704e954931349Da37F60E39f515c11c1',
  WELL:    '0xA88594D404727625A9437C3f886C7643872296AE',
};

const FEE_100  = 100;
const FEE_500  = 500;
const FEE_3000 = 3000;

// Symmetric fee-tier table for the deepest V3 pool on Base for each known
// pair. Key is the lowercase pair, sorted alphabetically and joined with `-`.
// Where a deeper pool exists but at a different tier, we still pick the one
// most reliable for liquidation-sized swaps (~$10–$5000) — depth at the size
// matters more than absolute TVL.
//
// Anything not listed here is routed through WETH as a 2-hop path when both
// `(tokenIn, WETH)` and `(WETH, tokenOut)` are listed; otherwise pickSwapPath
// returns null and the adapter skips that pair.
export const BASE_FEE_TIERS = Object.freeze(buildFeeTable([
  [TOKENS_BASE.WETH,   TOKENS_BASE.USDC,   FEE_500],
  [TOKENS_BASE.WETH,   TOKENS_BASE.USDbC,  FEE_500],
  [TOKENS_BASE.WETH,   TOKENS_BASE.cbETH,  FEE_500],
  [TOKENS_BASE.WETH,   TOKENS_BASE.cbBTC,  FEE_3000],
  [TOKENS_BASE.WETH,   TOKENS_BASE.DAI,    FEE_3000],
  [TOKENS_BASE.WETH,   TOKENS_BASE.AERO,   FEE_3000],
  [TOKENS_BASE.WETH,   TOKENS_BASE.wstETH, FEE_100],
  [TOKENS_BASE.WETH,   TOKENS_BASE.weETH,  FEE_500],
  [TOKENS_BASE.WETH,   TOKENS_BASE.rETH,   FEE_500],
  [TOKENS_BASE.WETH,   TOKENS_BASE.WELL,   FEE_3000],
  [TOKENS_BASE.WETH,   TOKENS_BASE.tBTC,   FEE_3000],
  [TOKENS_BASE.WETH,   TOKENS_BASE.LBTC,   FEE_3000],
  [TOKENS_BASE.USDC,   TOKENS_BASE.USDbC,  FEE_100],
  [TOKENS_BASE.USDC,   TOKENS_BASE.DAI,    FEE_100],
  [TOKENS_BASE.USDC,   TOKENS_BASE.EURC,   FEE_500],
  [TOKENS_BASE.USDC,   TOKENS_BASE.USDS,   FEE_100],
  [TOKENS_BASE.USDC,   TOKENS_BASE.cbBTC,  FEE_3000],
  [TOKENS_BASE.cbBTC,  TOKENS_BASE.tBTC,   FEE_3000],
  [TOKENS_BASE.cbBTC,  TOKENS_BASE.LBTC,   FEE_3000],
]));

function buildFeeTable(rows) {
  const table = {};
  for (const [a, b, fee] of rows) {
    table[pairKey(a, b)] = fee;
  }
  return table;
}

function pairKey(a, b) {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al < bl ? `${al}-${bl}` : `${bl}-${al}`;
}

/**
 * Build a Uniswap V3 packed swap path (`bytes`) for `tokenIn → tokenOut`.
 *
 * Returns:
 *   - `'0x'` when `tokenIn === tokenOut` (Liquidator.sol short-circuits the
 *     swap; the seized collateral underlying already equals the borrow asset).
 *   - A single-hop packed path when the pair is in `BASE_FEE_TIERS`.
 *   - A two-hop path through WETH when both legs are in the table.
 *   - `null` when no confident route exists. The adapter must skip this pair
 *     rather than guess — a wrong fee tier means a guaranteed on-chain revert.
 *
 * The encoding (Uniswap V3): `address(20) || uint24(3) || address(20) [|| ...]`,
 * built with viem's hex utilities (no abi.encodePacked equivalent in JS, but
 * concatenating the lowercase hex strings is exactly that).
 *
 * @param {`0x${string}`} tokenIn  Underlying token the contract holds (collateral).
 * @param {`0x${string}`} tokenOut Underlying token the contract owes (debt).
 * @returns {`0x${string}` | null}
 */
export function pickSwapPath(tokenIn, tokenOut) {
  if (!isAddress(tokenIn) || !isAddress(tokenOut)) {
    throw new Error(`pickSwapPath: bad address tokenIn=${tokenIn} tokenOut=${tokenOut}`);
  }
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) return '0x';

  const direct = BASE_FEE_TIERS[pairKey(tokenIn, tokenOut)];
  if (direct) return encodePath([tokenIn, tokenOut], [direct]);

  const weth = TOKENS_BASE.WETH;
  const inIsWeth  = tokenIn.toLowerCase()  === weth.toLowerCase();
  const outIsWeth = tokenOut.toLowerCase() === weth.toLowerCase();
  if (inIsWeth || outIsWeth) {
    // We already missed `direct`, so the one-hop pair through WETH isn't in
    // the table — no point trying a two-hop that just re-uses WETH.
    return null;
  }

  const legA = BASE_FEE_TIERS[pairKey(tokenIn, weth)];
  const legB = BASE_FEE_TIERS[pairKey(weth, tokenOut)];
  if (!legA || !legB) return null;
  return encodePath([tokenIn, weth, tokenOut], [legA, legB]);
}

/**
 * Sum of fee tiers along the path, in basis points of the input. Used by
 * `estimateProfit` to subtract the Uniswap pool fees from gross profit.
 *
 * For a single 500-tier hop this returns 5n (5 bps). For 500+3000 multi-hop,
 * 35n. This is a first-order approximation — exact compounding fee on
 * `exactInput` is `1 - (1-f1)(1-f2)`, but the difference is sub-bp and the
 * static slippage buffer in the adapter dominates anyway.
 */
export function pathFeeBps(tokenIn, tokenOut) {
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) return 0n;
  const direct = BASE_FEE_TIERS[pairKey(tokenIn, tokenOut)];
  if (direct) return BigInt(direct) / 100n;
  const weth = TOKENS_BASE.WETH;
  const legA = BASE_FEE_TIERS[pairKey(tokenIn, weth)];
  const legB = BASE_FEE_TIERS[pairKey(weth, tokenOut)];
  if (!legA || !legB) return 0n;
  return BigInt(legA) / 100n + BigInt(legB) / 100n;
}

function encodePath(tokens, fees) {
  if (tokens.length !== fees.length + 1) {
    throw new Error(`encodePath: ${tokens.length} tokens vs ${fees.length} fees`);
  }
  let hex = '0x';
  for (let i = 0; i < fees.length; i++) {
    hex += stripHex(tokens[i]);
    hex += fees[i].toString(16).padStart(6, '0'); // uint24 = 3 bytes = 6 hex chars
  }
  hex += stripHex(tokens[tokens.length - 1]);
  return hex.toLowerCase();
}

function stripHex(addr) {
  return addr.startsWith('0x') ? addr.slice(2) : addr;
}
