import { describe, it, expect, vi } from 'vitest';
import { decodeFunctionData } from 'viem';
import { MoonwellAdapter } from '../../adapters/MoonwellAdapter.js';
import { TOKENS_BASE } from '../../config/uniswap.js';

const COMPTROLLER       = '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C';
const ORACLE            = '0xeeee000000000000000000000000000000000099';
const LIQUIDATOR        = '0xC0Ffee0000000000000000000000000000000001';

const MWETH  = { symbol: 'mWETH',  address: '0x1111111111111111111111111111111111111111', underlying: 'WETH' };
const MUSDC  = { symbol: 'mUSDC',  address: '0x2222222222222222222222222222222222222222', underlying: 'USDC' };
const MTOKENS = [MWETH, MUSDC];

const WAD = 1_000_000_000_000_000_000n;
const CLOSE_FACTOR_50 = WAD / 2n;
const INCENTIVE_8     = WAD + WAD * 8n / 100n;
const USDC_PRICE_1USD    = 10n ** 30n;
const WETH_PRICE_3000USD = 3000n * WAD;

const LIQUIDATE_ABI = [{
  type: 'function',
  name: 'liquidate',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'borrower',         type: 'address' },
    { name: 'mTokenBorrow',     type: 'address' },
    { name: 'mTokenCollateral', type: 'address' },
    { name: 'repayAmount',      type: 'uint256' },
    { name: 'swapPath',         type: 'bytes' },
    { name: 'amountOutMinimum', type: 'uint256' },
  ],
  outputs: [],
}];

function ok(result) { return { status: 'success', result }; }

function metaFor(mTokens) {
  const map = new Map();
  for (const m of mTokens) {
    const underlying = TOKENS_BASE[m.underlying];
    const decimals = m.underlying === 'USDC' ? 6 : 18;
    map.set(m.address.toLowerCase(), { underlying, decimals, symbol: m.symbol });
  }
  return map;
}

function buildAdapter({ liquidatorAddress } = {}) {
  const multicall = vi.fn()
    .mockResolvedValueOnce([CLOSE_FACTOR_50, INCENTIVE_8, ORACLE])
    .mockResolvedValueOnce([
      ok(USDC_PRICE_1USD),
      ok(WETH_PRICE_3000USD),
      ok(WAD), // exchangeRate(mWETH)
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
    liquidatorAddress,
  });
  adapter._tokenMeta = metaFor(MTOKENS);
  return adapter;
}

const POSITION = {
  protocol: 'moonwell',
  borrower: '0xbeef000000000000000000000000000000000001',
  shortfall: 100n,
  liquidity: 0n,
  // 1000 USDC debt
  debts: [{ mToken: MUSDC.address, symbol: 'mUSDC', amount: 1_000_000_000n }],
  // 1 WETH collateral
  collaterals: [{ mToken: MWETH.address, symbol: 'mWETH', cTokenAmount: WAD }],
};

// Expected packed V3 path for WETH → USDC at 500-bps tier (5 = 500 → 0001f4).
const EXPECTED_PATH_WETH_USDC =
  ('0x' +
    TOKENS_BASE.WETH.slice(2) +
    '0001f4' +
    TOKENS_BASE.USDC.slice(2)
  ).toLowerCase();

describe('MoonwellAdapter.buildLiquidationCall', () => {
  it('encodes liquidate(...) with the pair and swap path chosen by estimateProfit', async () => {
    const adapter = buildAdapter({ liquidatorAddress: LIQUIDATOR });
    const position = structuredClone(POSITION);

    await adapter.estimateProfit(position);
    const tx = adapter.buildLiquidationCall(position);

    expect(tx.to).toBe(LIQUIDATOR);
    expect(tx.value).toBe(0n);
    expect(tx.data.startsWith('0x')).toBe(true);

    const decoded = decodeFunctionData({ abi: LIQUIDATE_ABI, data: tx.data });
    expect(decoded.functionName).toBe('liquidate');
    const [borrower, mTokenBorrow, mTokenCollateral, repayAmount, swapPath, amountOutMinimum] = decoded.args;
    expect(borrower.toLowerCase()).toBe(POSITION.borrower.toLowerCase());
    expect(mTokenBorrow.toLowerCase()).toBe(MUSDC.address.toLowerCase());
    expect(mTokenCollateral.toLowerCase()).toBe(MWETH.address.toLowerCase());
    // 1000 USDC debt × 50% closeFactor = 500 USDC raw (6 dec).
    expect(repayAmount).toBe(500_000_000n);
    // Cross-asset: WETH collateral → USDC debt path.
    expect(swapPath.toLowerCase()).toBe(EXPECTED_PATH_WETH_USDC);
    // amountOutMinimum = repay * (1 + 5/10000) * (1 - 15/10000) for tight pair (WETH↔USDC).
    // = 500_000_000 * 10005 * 9985 / 1e8 = 499_499_625
    expect(amountOutMinimum).toBe(499_499_625n);
  });

  it('caps repayAmount by available collateral', async () => {
    const adapter = buildAdapter({ liquidatorAddress: LIQUIDATOR });
    const position = structuredClone(POSITION);
    // Shrink collateral to $30 worth of WETH (0.01 ETH at $3000).
    position.collaterals = [{ mToken: MWETH.address, symbol: 'mWETH', cTokenAmount: WAD / 100n }];

    await adapter.estimateProfit(position);
    const tx = adapter.buildLiquidationCall(position);

    const decoded = decodeFunctionData({ abi: LIQUIDATE_ABI, data: tx.data });
    const repayAmount = decoded.args[3];
    // collateralUsd = $30, capped repay = 30 / 1.08 ≈ $27.7777 → 27_777_777 raw.
    // Allow ±1 unit for bigint truncation.
    expect(repayAmount).toBeGreaterThan(27_777_770n);
    expect(repayAmount).toBeLessThan(27_777_785n);
  });

  it('throws if estimateProfit was not called first', async () => {
    const adapter = buildAdapter({ liquidatorAddress: LIQUIDATOR });
    expect(() => adapter.buildLiquidationCall(structuredClone(POSITION)))
      .toThrow(/call estimateProfit/);
  });

  it('throws if no liquidator address is configured anywhere', async () => {
    const adapter = buildAdapter(); // no liquidatorAddress
    const position = structuredClone(POSITION);
    await adapter.estimateProfit(position);
    expect(() => adapter.buildLiquidationCall(position))
      .toThrow(/liquidatorAddress required/);
  });
});
