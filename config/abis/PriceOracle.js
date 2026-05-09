/**
 * Compound v2 / Moonwell PriceOracle — minimal interface.
 *
 * `getUnderlyingPrice(mToken)` returns the underlying-asset price scaled to
 *   1e36 / underlyingDecimals
 * so that `tokenAmount * price / 1e36` is a plain USD amount, or
 * `tokenAmount * price / 1e18` is USD scaled to 1e18 ("WAD").
 *
 * Examples:
 *   USDC ($1, 6 dec)  ⇒ price = 1e30
 *   WETH ($3000, 18 dec) ⇒ price = 3e21
 *   cbBTC ($60000, 8 dec) ⇒ price = 6e32
 */

export const PRICE_ORACLE_ABI = [
  {
    type: 'function',
    name: 'getUnderlyingPrice',
    stateMutability: 'view',
    inputs: [{ name: 'mToken', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
];
