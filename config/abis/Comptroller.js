/**
 * Moonwell Comptroller ABI — minimal subset used by the adapter.
 * The Comptroller is a Compound v2 fork; only the methods we actually call
 * are listed here to keep multicall encoding deterministic.
 */

export const COMPTROLLER_ABI = [
  // Returns (error, liquidity, shortfall). shortfall > 0 ⇒ liquidatable.
  {
    type: 'function',
    name: 'getAccountLiquidity',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [
      { name: 'error', type: 'uint256' },
      { name: 'liquidity', type: 'uint256' },
      { name: 'shortfall', type: 'uint256' },
    ],
  },
  // The set of mTokens the account has entered (collateral side).
  {
    type: 'function',
    name: 'getAssetsIn',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'address[]' }],
  },
  // Static market list; consulted by `verify-moonwell-config.js`.
  {
    type: 'function',
    name: 'getAllMarkets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address[]' }],
  },
  // Max fraction of debt the liquidator may repay per call. 1e18 = 100%.
  {
    type: 'function',
    name: 'closeFactorMantissa',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // Multiplier on collateral seized per unit of debt repaid. 1.08e18 ⇒ 8% bonus.
  {
    type: 'function',
    name: 'liquidationIncentiveMantissa',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // Address of the price oracle.
  {
    type: 'function',
    name: 'oracle',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
];
