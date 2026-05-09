/**
 * Aerodrome (Solidly fork) routing on Base mainnet.
 *
 * Aerodrome's router is the deepest venue for Base long-tail tokens that
 * have no buildable Uniswap V3 path back to a tight debt-token (USDC, WETH).
 * Its `swapExactTokensForTokens` takes a `Route[]` array — *not* a packed
 * bytes path — so it gets a parallel entry point in `Liquidator.sol`.
 *
 * Route shape (Solidly fork):
 *   struct Route { address from; address to; bool stable; address factory; }
 *
 * `factory == address(0)` instructs the router to use its `defaultFactory`,
 * which is the canonical PoolFactory. Listing the default explicitly makes
 * the route reproducible across router upgrades.
 *
 * The token addresses below are the on-chain underlyings reported by each
 * mToken's `underlying()` call — verified once during Stage 6.B against the
 * live Moonwell deployment.
 */
import { TOKENS_BASE, pickSwapPath } from './uniswap.js';

export const AERODROME_ROUTER = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43';
// PoolFactory — the default factory the router falls back to when factory
// is address(0). Kept as a named export for fork tests / observability.
export const AERODROME_DEFAULT_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';

const ZERO_FACTORY = '0x0000000000000000000000000000000000000000';

// Long-tail Moonwell underlyings without a Uniswap V3 route to USDC/WETH.
// Exposed by symbol for readability; runtime indexes by lowercase address.
export const BASE_AERO_TOKENS = Object.freeze({
  AERO:    '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
  VIRTUAL: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b',
  MORPHO:  '0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842',
  cbXRP:   '0xcb585250f852C6c6bf90434AB21A00f02833a4af',
  MAMO:    '0x7300B37DfdfAb110d83290A29DfB31B1740219fE',
  VVV:     '0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf',
  wrsETH:  '0xEDfa23602D0EC14714057867A78d01e94176BEA0',
});

// Per-token Aerodrome hop. `hopVia: 'WETH'` means the deepest pair pivots
// through WETH; `stable` is the bool passed to the Solidly route entry.
const HOPS = new Map([
  [BASE_AERO_TOKENS.AERO.toLowerCase(),    { hopVia: 'WETH', stable: false }],
  [BASE_AERO_TOKENS.VIRTUAL.toLowerCase(), { hopVia: 'WETH', stable: false }],
  [BASE_AERO_TOKENS.MORPHO.toLowerCase(),  { hopVia: 'WETH', stable: false }],
  [BASE_AERO_TOKENS.cbXRP.toLowerCase(),   { hopVia: 'WETH', stable: false }],
  [BASE_AERO_TOKENS.MAMO.toLowerCase(),    { hopVia: 'WETH', stable: false }],
  [BASE_AERO_TOKENS.VVV.toLowerCase(),     { hopVia: 'WETH', stable: false }],
  [BASE_AERO_TOKENS.wrsETH.toLowerCase(),  { hopVia: 'WETH', stable: true  }],
]);

// WETH/USDC has both stable and volatile pools on Aerodrome; the volatile
// pool carries the deep liquidity for liquidation-sized exits.
const WETH_USDC_AERO_STABLE = false;

/**
 * Build an Aerodrome `Route[]` for `tokenIn → tokenOut`, or `null` when no
 * confident route exists.
 *
 *   - Direct: longTail → WETH (one hop).
 *   - Two-hop: longTail → WETH → USDC.
 *
 * Returns route entries shaped exactly like the Solidly Route struct, with
 * `factory: 0x000...0` so the router picks its defaultFactory at runtime.
 *
 * @param {`0x${string}`} tokenIn
 * @param {`0x${string}`} tokenOut
 * @returns {Array<{from:`0x${string}`, to:`0x${string}`, stable:boolean, factory:`0x${string}`}> | null}
 */
export function pickAeroRoutes(tokenIn, tokenOut) {
  if (!tokenIn || !tokenOut) return null;
  const tin = tokenIn.toLowerCase();
  const tout = tokenOut.toLowerCase();
  if (tin === tout) return null;

  const hop = HOPS.get(tin);
  if (!hop) return null;

  const weth = TOKENS_BASE.WETH.toLowerCase();
  const usdc = TOKENS_BASE.USDC.toLowerCase();

  if (hop.hopVia === 'WETH') {
    if (tout === weth) {
      return [route(tokenIn, TOKENS_BASE.WETH, hop.stable)];
    }
    if (tout === usdc) {
      return [
        route(tokenIn, TOKENS_BASE.WETH, hop.stable),
        route(TOKENS_BASE.WETH, TOKENS_BASE.USDC, WETH_USDC_AERO_STABLE),
      ];
    }
  }
  return null;
}

/**
 * Pick the cheapest swap venue. V3 wins when present (concentrated liquidity,
 * lower fees on tight pairs); Aerodrome covers the long-tail gap.
 *
 * Returns one of:
 *   - { venue: 'V3',   swapPath: '0x...' }
 *   - { venue: 'AERO', aeroRoutes: [...] }
 *   - null              (no buildable route — adapter must skip)
 *
 * `pickSwapPath` short-circuits to `'0x'` for same-asset pairs; in that case
 * we still report 'V3' because the on-chain contract treats `swapPath = '0x'`
 * as "skip the swap" — i.e. no venue interaction at all.
 *
 * @param {`0x${string}`} tokenIn
 * @param {`0x${string}`} tokenOut
 */
export function pickSwapVenue(tokenIn, tokenOut) {
  const v3 = pickSwapPath(tokenIn, tokenOut);
  if (v3 !== null) return { venue: 'V3', swapPath: v3 };
  const aero = pickAeroRoutes(tokenIn, tokenOut);
  if (aero !== null) return { venue: 'AERO', aeroRoutes: aero };
  return null;
}

function route(from, to, stable) {
  return { from, to, stable, factory: ZERO_FACTORY };
}
