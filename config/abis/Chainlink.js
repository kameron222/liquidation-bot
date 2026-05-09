/**
 * Chainlink AggregatorV3 — read-only price feed. The Morpho adapter uses the
 * Base ETH/USD feed for two conversions Morpho's own oracles can't give us:
 *   - gas cost (paid in ETH) → USD, for the MIN_PROFIT_USD gate.
 *   - profit denominated in a WETH loan token → USD.
 *
 * Morpho market oracles only price collateral *in the loan token*, so a USD
 * anchor is needed. Stablecoin loan tokens are pinned to $1 in config/morpho.js;
 * WETH loan tokens (and always gas) resolve through this feed.
 *
 * `latestRoundData` returns `answer` scaled by `decimals()` (8 for USD feeds).
 */
export const CHAINLINK_AGGREGATOR_ABI = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId',         type: 'uint80'  },
      { name: 'answer',          type: 'int256'  },
      { name: 'startedAt',       type: 'uint256' },
      { name: 'updatedAt',       type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80'  },
    ],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
];
