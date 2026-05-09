import { describe, it, expect, vi } from 'vitest';
import { decodeFunctionData } from 'viem';
import {
  pickAeroRoutes,
  pickSwapVenue,
  AERODROME_ROUTER,
  BASE_AERO_TOKENS,
} from '../../config/aerodrome.js';
import { TOKENS_BASE } from '../../config/uniswap.js';
import { MoonwellAdapter } from '../../adapters/MoonwellAdapter.js';

const ZERO = '0x0000000000000000000000000000000000000000';

describe('pickAeroRoutes', () => {
  it('builds a single-hop route from a long-tail token to WETH', () => {
    const r = pickAeroRoutes(BASE_AERO_TOKENS.AERO, TOKENS_BASE.WETH);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      from: BASE_AERO_TOKENS.AERO,
      to:   TOKENS_BASE.WETH,
      stable: false,
      factory: ZERO,
    });
  });

  it('builds a two-hop route via WETH from long-tail to USDC', () => {
    const r = pickAeroRoutes(BASE_AERO_TOKENS.MORPHO, TOKENS_BASE.USDC);
    expect(r).toHaveLength(2);
    expect(r[0].from.toLowerCase()).toBe(BASE_AERO_TOKENS.MORPHO.toLowerCase());
    expect(r[0].to.toLowerCase()).toBe(TOKENS_BASE.WETH.toLowerCase());
    expect(r[1].from.toLowerCase()).toBe(TOKENS_BASE.WETH.toLowerCase());
    expect(r[1].to.toLowerCase()).toBe(TOKENS_BASE.USDC.toLowerCase());
  });

  it('returns null for tokens not in the long-tail table', () => {
    expect(pickAeroRoutes(TOKENS_BASE.cbETH, TOKENS_BASE.USDC)).toBeNull();
  });

  it('returns null for an unsupported destination', () => {
    expect(pickAeroRoutes(BASE_AERO_TOKENS.AERO, TOKENS_BASE.cbBTC)).toBeNull();
  });

  it('marks wrsETH as stable on the first hop', () => {
    const r = pickAeroRoutes(BASE_AERO_TOKENS.wrsETH, TOKENS_BASE.WETH);
    expect(r).toHaveLength(1);
    expect(r[0].stable).toBe(true);
  });
});

describe('pickSwapVenue', () => {
  it('returns V3 for tight pairs (covered by Uniswap)', () => {
    const v = pickSwapVenue(TOKENS_BASE.WETH, TOKENS_BASE.USDC);
    expect(v?.venue).toBe('V3');
    expect(typeof v?.swapPath).toBe('string');
  });

  it('returns AERO for long-tail tokens not covered by V3', () => {
    const v = pickSwapVenue(BASE_AERO_TOKENS.AERO, TOKENS_BASE.USDC);
    // AERO actually has a V3 pool (AERO/WETH 3000 + WETH/USDC 500), so this
    // case picks V3 as the cheaper route.
    expect(v?.venue).toBe('V3');
  });

  it('returns AERO for tokens with no V3 path at all', () => {
    const v = pickSwapVenue(BASE_AERO_TOKENS.MORPHO, TOKENS_BASE.USDC);
    expect(v?.venue).toBe('AERO');
    expect(v?.aeroRoutes).toHaveLength(2);
  });

  it('returns null when neither venue can route', () => {
    // A wholly unknown long-tail token with no entry anywhere.
    expect(pickSwapVenue('0xabcdef0000000000000000000000000000000001', TOKENS_BASE.USDC)).toBeNull();
  });
});

// -- Adapter dispatch test -------------------------------------------------

const COMPTROLLER = '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C';
const ORACLE      = '0xeeee000000000000000000000000000000000099';
const LIQUIDATOR  = '0xC0Ffee0000000000000000000000000000000001';

const MMORPHO = { symbol: 'mMORPHO', address: '0xaaaa000000000000000000000000000000000001', underlying: 'MORPHO' };
const MUSDC   = { symbol: 'mUSDC',   address: '0xbbbb000000000000000000000000000000000002', underlying: 'USDC'   };
const MTOKENS = [MMORPHO, MUSDC];

const WAD = 1_000_000_000_000_000_000n;
const CLOSE_FACTOR_50 = WAD / 2n;
const INCENTIVE_8     = WAD + (WAD * 8n) / 100n;
const USDC_PRICE_1USD     = 10n ** 30n;       // 1e36 / 1e6
const MORPHO_PRICE_2USD   = 2n * WAD;         // 1e36 / 1e18 * 2

function ok(result) { return { status: 'success', result }; }

function buildAdapter() {
  const multicall = vi.fn()
    .mockResolvedValueOnce([CLOSE_FACTOR_50, INCENTIVE_8, ORACLE])
    .mockResolvedValueOnce([
      ok(MORPHO_PRICE_2USD),
      ok(USDC_PRICE_1USD),
      ok(WAD),                                    // exchangeRate(mMORPHO)
    ]);

  const client = {
    multicall,
    getGasPrice: vi.fn().mockResolvedValue(0n),
    getBlockNumber: vi.fn().mockResolvedValue(0n),
    getLogs: vi.fn().mockResolvedValue([]),
  };

  const adapter = new MoonwellAdapter({
    client,
    comptroller: COMPTROLLER,
    mTokens: MTOKENS,
    deployBlock: 0n,
    liquidatorAddress: LIQUIDATOR,
  });
  // Pre-populate token metadata so estimateProfit doesn't try the on-chain
  // underlying() call. Underlyings come from BASE_AERO_TOKENS / TOKENS_BASE.
  adapter._tokenMeta = new Map([
    [MMORPHO.address.toLowerCase(), { underlying: BASE_AERO_TOKENS.MORPHO, decimals: 18, symbol: 'mMORPHO' }],
    [MUSDC.address.toLowerCase(),   { underlying: TOKENS_BASE.USDC,        decimals: 6,  symbol: 'mUSDC'   }],
  ]);
  return adapter;
}

const POSITION = {
  protocol: 'moonwell',
  borrower: '0xbeef000000000000000000000000000000000001',
  shortfall: 1n,
  liquidity: 0n,
  // 1000 USDC debt
  debts: [{ mToken: MUSDC.address, symbol: 'mUSDC', amount: 1_000_000_000n }],
  // 100 MORPHO collateral ($200 worth at $2/MORPHO)
  collaterals: [{ mToken: MMORPHO.address, symbol: 'mMORPHO', cTokenAmount: 100n * WAD }],
};

const LIQUIDATE_AERO_ABI = [{
  type: 'function',
  name: 'liquidateAero',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'borrower',         type: 'address' },
    { name: 'mTokenBorrow',     type: 'address' },
    { name: 'mTokenCollateral', type: 'address' },
    { name: 'repayAmount',      type: 'uint256' },
    {
      name: 'aeroRoutes',
      type: 'tuple[]',
      components: [
        { name: 'from',    type: 'address' },
        { name: 'to',      type: 'address' },
        { name: 'stable',  type: 'bool'    },
        { name: 'factory', type: 'address' },
      ],
    },
    { name: 'amountOutMinimum', type: 'uint256' },
  ],
  outputs: [],
}];

describe('MoonwellAdapter.buildLiquidationCall (Aerodrome venue)', () => {
  it('encodes liquidateAero(...) with the route chosen by estimateProfit', async () => {
    const adapter = buildAdapter();
    const position = structuredClone(POSITION);

    await adapter.estimateProfit(position);
    expect(position._plan.venue).toBe('AERO');
    expect(position._plan.aeroRoutes).toHaveLength(2);

    const tx = adapter.buildLiquidationCall(position);
    expect(tx.to).toBe(LIQUIDATOR);
    expect(tx.value).toBe(0n);

    const decoded = decodeFunctionData({ abi: LIQUIDATE_AERO_ABI, data: tx.data });
    expect(decoded.functionName).toBe('liquidateAero');
    const [borrower, mTokenBorrow, mTokenCollateral, repayAmount, aeroRoutes, amountOutMinimum] = decoded.args;
    expect(borrower.toLowerCase()).toBe(POSITION.borrower.toLowerCase());
    expect(mTokenBorrow.toLowerCase()).toBe(MUSDC.address.toLowerCase());
    expect(mTokenCollateral.toLowerCase()).toBe(MMORPHO.address.toLowerCase());
    expect(repayAmount).toBe(500_000_000n); // 50% close factor of $1000 USDC
    expect(aeroRoutes).toHaveLength(2);
    expect(aeroRoutes[0].from.toLowerCase()).toBe(BASE_AERO_TOKENS.MORPHO.toLowerCase());
    expect(aeroRoutes[1].to.toLowerCase()).toBe(TOKENS_BASE.USDC.toLowerCase());
    // amountOutMinimum = 500_000_000 * 10005 * 9900 / 1e8 (Aerodrome uses 100 bps haircut)
    // = 5 * 10005 * 9900 = 495_247_500
    expect(amountOutMinimum).toBe(495_247_500n);
  });
});

describe('AERODROME_ROUTER constant', () => {
  it('exports the canonical router address', () => {
    expect(AERODROME_ROUTER.toLowerCase()).toBe('0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43');
  });
});
