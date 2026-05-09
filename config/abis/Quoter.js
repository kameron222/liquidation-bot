/**
 * Uniswap V3 QuoterV2 — used by the Morpho adapter to price the collateral→loan
 * swap against *live* pool reserves instead of a static slippage haircut.
 *
 * `quoteExactInput` is not a `view` function (it mutates then reverts to bubble
 * the result), so it must be called via `eth_call` / viem `simulateContract`,
 * never `readContract`. It returns the exact `amountOut` a real `exactInput`
 * swap would produce at the current tick, which we use to size
 * `amountOutMinimum` and to reject candidates whose swap wouldn't cover repay.
 *
 * Base deployment: https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments
 */
export const QUOTER_V2_ABI = [{
  type: 'function',
  name: 'quoteExactInput',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'path',     type: 'bytes'   },
    { name: 'amountIn', type: 'uint256' },
  ],
  outputs: [
    { name: 'amountOut',              type: 'uint256'   },
    { name: 'sqrtPriceX96AfterList', type: 'uint160[]' },
    { name: 'initializedTicksCrossedList', type: 'uint32[]' },
    { name: 'gasEstimate',           type: 'uint256'   },
  ],
}];
