/**
 * Morpho Blue on Base mainnet — protocol addresses + market configuration.
 *
 * Morpho Blue is a single immutable singleton holding every isolated market.
 * Unlike Compound/Moonwell there is no Comptroller and no global price oracle:
 * each market carries its own oracle that prices *collateral in loan-token*
 * terms. USD is reconstructed off-chain (stablecoin loan tokens are pinned to
 * $1; WETH and gas resolve through the Chainlink ETH/USD feed).
 *
 * A market is identified by `Id = keccak256(abi.encode(MarketParams))`. We ship
 * the human-readable `MarketParams` and derive the id with `marketId()` so the
 * config stays legible and a fat-fingered id can't silently point at the wrong
 * market. `MorphoBlueAdapter` additionally round-trips every configured market
 * through `idToMarketParams(id)` on startup and skips any that don't match the
 * live deployment — so a stale oracle/irm address fails loud-and-safe rather
 * than producing a bad liquidation.
 *
 * Re-verify markets with `npm run verify:morpho` whenever you add one or when
 * Morpho lists new markets. Oracle/irm addresses below are the flagship Base
 * markets; treat them as needing verification against the live singleton.
 *
 * Sources:
 *   - Singleton + IRM: https://docs.morpho.org/addresses (Base, chainId 8453)
 *   - Uniswap QuoterV2: https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments
 *   - Chainlink ETH/USD (Base): https://docs.chain.link/data-feeds/price-feeds/addresses?network=base
 */

import { base } from 'viem/chains';
import { keccak256, encodeAbiParameters } from 'viem';
import { TOKENS_BASE } from './uniswap.js';

// Morpho Blue singleton — same address on every chain it's deployed to.
export const MORPHO_SINGLETON = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';

// Adaptive Curve IRM — the only IRM used by Morpho markets on Base.
export const MORPHO_ADAPTIVE_IRM = '0x46415998764C29aB2a25CbeA6254146D50D22687';

// Uniswap V3 QuoterV2 on Base — live-reserve quotes for the collateral→loan swap.
export const UNISWAP_QUOTER_V2 = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';

// Chainlink ETH/USD aggregator on Base (8 decimals).
export const CHAINLINK_ETH_USD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';

// Morpho Blue's on-chain constants (src/libraries/ConstantsLib.sol).
export const ORACLE_PRICE_SCALE = 10n ** 36n;
export const VIRTUAL_SHARES = 10n ** 6n;
export const VIRTUAL_ASSETS = 1n;
export const LIQUIDATION_CURSOR = 300_000_000_000_000_000n;              // 0.3e18
export const MAX_LIQUIDATION_INCENTIVE_FACTOR = 1_150_000_000_000_000_000n; // 1.15e18

// Loan tokens we can price in USD without an external oracle. Stables pin to
// $1; WETH resolves through the Chainlink feed at runtime (kind: 'ETH').
// A market whose loan token isn't listed here is skipped (we can't gate it on
// MIN_PROFIT_USD honestly).
export const LOAN_TOKEN_USD = Object.freeze({
  [TOKENS_BASE.USDC.toLowerCase()]:  { kind: 'STABLE', usd: 1 },
  [TOKENS_BASE.USDbC.toLowerCase()]: { kind: 'STABLE', usd: 1 },
  [TOKENS_BASE.DAI.toLowerCase()]:   { kind: 'STABLE', usd: 1 },
  [TOKENS_BASE.USDS.toLowerCase()]:  { kind: 'STABLE', usd: 1 },
  [TOKENS_BASE.WETH.toLowerCase()]:  { kind: 'ETH' },
});

/**
 * MarketParams → Id. `Id = keccak256(abi.encode(marketParams))` where the
 * struct encodes as a 5-field tuple. This is the canonical id every Morpho
 * getter keys on.
 *
 * @param {{ loanToken:`0x${string}`, collateralToken:`0x${string}`, oracle:`0x${string}`, irm:`0x${string}`, lltv:bigint }} p
 * @returns {`0x${string}`}
 */
export function marketId(p) {
  return keccak256(encodeAbiParameters(
    [{
      type: 'tuple',
      components: [
        { name: 'loanToken',       type: 'address' },
        { name: 'collateralToken', type: 'address' },
        { name: 'oracle',          type: 'address' },
        { name: 'irm',             type: 'address' },
        { name: 'lltv',            type: 'uint256' },
      ],
    }],
    [{
      loanToken: p.loanToken,
      collateralToken: p.collateralToken,
      oracle: p.oracle,
      irm: p.irm,
      lltv: p.lltv,
    }],
  ));
}

// Attach the derived id + a display name to a raw market params object.
function market(name, params) {
  return { name, id: marketId(params), ...params };
}

/**
 * Configured markets. Each entry is the full MarketParams; the adapter derives
 * the id and validates it against `idToMarketParams` on startup, skipping any
 * that don't round-trip. Add markets here (loan token must be in LOAN_TOKEN_USD)
 * and confirm with `npm run verify:morpho`.
 *
 * The oracle addresses below are Morpho's flagship Base markets and MUST be
 * re-verified against the live singleton before running with real funds.
 */
export const MORPHO_BASE = {
  chain: base,
  morpho: MORPHO_SINGLETON,
  irm: MORPHO_ADAPTIVE_IRM,
  quoter: UNISWAP_QUOTER_V2,
  chainlinkEthUsd: CHAINLINK_ETH_USD,

  // Morpho Blue was deployed to Base around this block; a conservative
  // scan-start for Borrow-event discovery.
  deployBlock: 13977148n,

  markets: [
    market('cbETH/USDC (86%)', {
      loanToken:       TOKENS_BASE.USDC,
      collateralToken: TOKENS_BASE.cbETH,
      oracle:          '0x4756c26E01E61c7c2F86b10f4316e179db8F9425',
      irm:             MORPHO_ADAPTIVE_IRM,
      lltv:            860_000_000_000_000_000n,
    }),
    market('WETH/USDC (86%)', {
      loanToken:       TOKENS_BASE.USDC,
      collateralToken: TOKENS_BASE.WETH,
      oracle:          '0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4',
      irm:             MORPHO_ADAPTIVE_IRM,
      lltv:            860_000_000_000_000_000n,
    }),
    market('cbBTC/USDC (86%)', {
      loanToken:       TOKENS_BASE.USDC,
      collateralToken: TOKENS_BASE.cbBTC,
      oracle:          '0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9',
      irm:             MORPHO_ADAPTIVE_IRM,
      lltv:            860_000_000_000_000_000n,
    }),
  ],
};
