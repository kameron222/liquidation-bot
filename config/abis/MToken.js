/**
 * Moonwell mToken (Compound v2 cToken) ABI — minimal subset used by adapter.
 *
 * borrowBalanceCurrent is `nonpayable` because it accrues interest before
 * returning. Inside an eth_call (which viem multicall uses), the mutation is
 * discarded but the post-accrual return value is what we want for accurate
 * shortfall sizing.
 */

export const MTOKEN_ABI = [
  {
    type: 'function',
    name: 'borrowBalanceCurrent',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'underlying',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  // Conversion ratio cToken → underlying. Scaled so that
  //   underlyingAmount = cTokenAmount * exchangeRateStored / 1e18
  // (regardless of underlying decimals — the rate absorbs that scaling).
  {
    type: 'function',
    name: 'exchangeRateStored',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
];
