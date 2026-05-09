/**
 * Moonwell on Base mainnet — protocol addresses + market configuration.
 *
 * Source: Comptroller.getAllMarkets() at block ~31M (May 2026), cross-checked
 * with https://docs.moonwell.fi/moonwell/protocol-information/contracts.
 * Re-verify by running `npm run verify:config` whenever Moonwell adds or
 * retires markets.
 *
 * Conventions:
 *   - All addresses in EIP-55 checksum form.
 *   - `symbol` matches the on-chain mToken.symbol().
 *   - `underlying` is the conventional ticker (informational; adapter doesn't
 *     key off it).
 *   - `deployBlock` is a conservative scan-start for Borrow event indexing —
 *     well before any market deployed.
 *
 * Note: two markets both report symbol "mUSDC" on chain. The 0x703843…
 * contract is the original USDbC market that was rebranded; the
 * 0xEdc817… contract is the native-USDC market. Both are still live.
 */

import { base } from 'viem/chains';

export const MOONWELL_BASE = {
  chain: base,

  comptroller: '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C',

  mTokens: [
    { symbol: 'mUSDC',    address: '0x703843C3379b52F9FF486c9f5892218d2a065cC8', underlying: 'USDbC' },
    { symbol: 'mWETH',    address: '0x628ff693426583D9a7FB391E54366292F509D457', underlying: 'WETH' },
    { symbol: 'mcbETH',   address: '0x3bf93770f2d4a794c3d9EBEfBAeBAE2a8f09A5E5', underlying: 'cbETH' },
    { symbol: 'mDAI',     address: '0x73b06D8d18De422E269645eaCe15400DE7462417', underlying: 'DAI' },
    { symbol: 'mUSDC',    address: '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22', underlying: 'USDC' },
    { symbol: 'mwstETH',  address: '0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b', underlying: 'wstETH' },
    { symbol: 'mrETH',    address: '0xCB1DaCd30638ae38F2B94eA64F066045B7D45f44', underlying: 'rETH' },
    { symbol: 'mAERO',    address: '0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6', underlying: 'AERO' },
    { symbol: 'mweETH',   address: '0xb8051464C8c92209C92F3a4CD9C73746C4c3CFb3', underlying: 'weETH' },
    { symbol: 'mcbBTC',   address: '0xF877ACaFA28c19b96727966690b2f44d35aD5976', underlying: 'cbBTC' },
    { symbol: 'mEURC',    address: '0xb682c840B5F4FC58B20769E691A6fa1305A501a2', underlying: 'EURC' },
    { symbol: 'mwrsETH',  address: '0xfC41B49d064Ac646015b459C522820DB9472F4B5', underlying: 'wrsETH' },
    { symbol: 'mWELL',    address: '0xdC7810B47eAAb250De623F0eE07764afa5F71ED1', underlying: 'WELL' },
    { symbol: 'mUSDS',    address: '0xb6419c6C2e60c4025D6D06eE4F913ce89425a357', underlying: 'USDS' },
    { symbol: 'mtBTC',    address: '0x9A858ebfF1bEb0D3495BB0e2897c1528eD84A218', underlying: 'tBTC' },
    { symbol: 'mLBTC',    address: '0x10fF57877b79e9bd949B3815220eC87B9fc5D2ee', underlying: 'LBTC' },
    { symbol: 'mVIRTUAL', address: '0xdE8Df9d942D78edE3Ca06e60712582F79CFfFC64', underlying: 'VIRTUAL' },
    { symbol: 'mMORPHO',  address: '0x6308204872BdB7432dF97b04B42443c714904F3E', underlying: 'MORPHO' },
    { symbol: 'mcbXRP',   address: '0xb4fb8fed5b3AaA8434f0B19b1b623d977e07e86d', underlying: 'cbXRP' },
    { symbol: 'mMAMO',    address: '0x2F90Bb22eB3979f5FfAd31EA6C3F0792ca66dA32', underlying: 'MAMO' },
    { symbol: 'mVVV',     address: '0xD64BCb70C613a6D1F4D7D57Ba64bb4a0767A9682', underlying: 'VVV' },
  ],

  deployBlock: 5852000n,
};
