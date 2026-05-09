import { describe, it, expect, vi } from 'vitest';
import { MorphoBlueAdapter } from '../../adapters/MorphoBlueAdapter.js';

const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const USDC   = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const cbETH  = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22';
const QUOTER = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';

const MARKET = {
  id: `0x${'11'.repeat(32)}`,
  name: 'cbETH/USDC (86%)',
  loanToken: USDC,
  collateralToken: cbETH,
  oracle: '0x4756c26E01E61c7c2F86b10f4316e179db8F9425',
  irm: '0x46415998764C29aB2a25CbeA6254146D50D22687',
  lltv: 860_000_000_000_000_000n,
};

const PRICE = 3_000_000_000_000_000_000_000_000_000n; // 3e27 → cbETH @ $3000
const COLLATERAL = 1_000_000_000_000_000_000n;        // 1 cbETH
const BORROW_ASSETS = 2_600_000_000n;                 // 2600 USDC (6dp)

function position() {
  return {
    protocol: 'morpho',
    market: MARKET,
    borrower: '0xbbbb000000000000000000000000000000000002',
    borrowShares: 2_600_000_000_000_000n,
    collateral: COLLATERAL,
    borrowAssets: BORROW_ASSETS,
    collateralPrice: PRICE,
  };
}

// Adapter primed so estimateProfit needs no network beyond getGasPrice (and,
// when useQuoter, simulateContract): loan decimals + ETH price are pre-cached.
function buildAdapter({ useQuoter = false, simulateContract, gasPrice = 0n } = {}) {
  const client = {
    multicall: vi.fn(),
    getGasPrice: vi.fn().mockResolvedValue(gasPrice),
    simulateContract: simulateContract ?? vi.fn(),
  };
  const adapter = new MorphoBlueAdapter({
    client,
    morpho: MORPHO,
    markets: [MARKET],
    quoter: QUOTER,
    useQuoter,
  });
  adapter._marketsValidated = true;
  adapter._loanDecimals.set(USDC.toLowerCase(), 6);
  adapter._ethUsd1e18 = 3_000_000_000_000_000_000_000n; // $3000, 1e18-scaled
  adapter._ethUsdAt = Date.now();
  return adapter;
}

describe('MorphoBlueAdapter.estimateProfit', () => {
  it('prices the liquidation incentive net of a static swap haircut (no quoter)', async () => {
    const adapter = buildAdapter({ useQuoter: false });
    const p = position();
    const est = await adapter.estimateProfit(p);

    // Gross bonus ≈ effectiveRepay * (LIF - 1). LIF ≈ 1.0438 at 86% LLTV, so
    // ~$114 on a $2600 repay.
    expect(est.profitUsd).toBeGreaterThan(110);
    expect(est.profitUsd).toBeLessThan(118);
    // Net is positive after the ~1.1% haircut, no flash-loan premium.
    expect(est.netUsd).toBeGreaterThan(75);
    expect(est.netUsd).toBeLessThan(est.profitUsd);
    expect(est.tradeCostsUsd).toBeGreaterThan(0);

    expect(p._plan).toBeTruthy();
    expect(p._plan.venue).toBe('V3');
    expect(typeof p._plan.swapPath).toBe('string');
    expect(p._plan.seizedAssets).toBeGreaterThan(0n);
    expect(p._plan.seizedAssets).toBeLessThanOrEqual(COLLATERAL);
    expect(p._plan.amountOutMinimum).toBeGreaterThan(0n);
  });

  it('uses a live QuoterV2 quote to size profit and amountOutMinimum', async () => {
    const swapOut = 2_700_000_000n; // 2700 USDC out of the swap
    const simulateContract = vi.fn().mockResolvedValue({ result: [swapOut, [], [], 0n] });
    const adapter = buildAdapter({ useQuoter: true, simulateContract });
    const p = position();

    const est = await adapter.estimateProfit(p);

    expect(simulateContract).toHaveBeenCalledTimes(1);
    const callArgs = simulateContract.mock.calls[0][0];
    expect(callArgs.functionName).toBe('quoteExactInput');
    expect(callArgs.args[0]).toBe(p._plan.swapPath); // path
    expect(callArgs.args[1]).toBe(p._plan.seizedAssets); // amountIn

    // netProfit = swapOut - repay = 2700 - 2600 = ~$100.
    expect(est.netUsd).toBeGreaterThan(95);
    expect(est.netUsd).toBeLessThan(105);
    // amountOutMinimum = quote * (1 - 50bps).
    expect(p._plan.amountOutMinimum).toBe((swapOut * 9950n) / 10000n);
  });

  it('falls back to the static haircut when the quoter reverts', async () => {
    const simulateContract = vi.fn().mockRejectedValue(new Error('SPL'));
    const adapter = buildAdapter({ useQuoter: true, simulateContract });
    const p = position();

    const est = await adapter.estimateProfit(p);
    expect(simulateContract).toHaveBeenCalledTimes(1);
    expect(est.netUsd).toBeGreaterThan(0); // still produces a plan via fallback
    expect(p._plan.venue).toBe('V3');
  });

  it('subtracts gas from the net once a gas price is present', async () => {
    const adapter = buildAdapter({ useQuoter: false, gasPrice: 100_000_000n }); // 0.1 gwei
    const p = position();
    const est = await adapter.estimateProfit(p);
    expect(est.gasCostUsd).toBeGreaterThan(0);
    expect(est.netUsd).toBeCloseTo(est.profitUsd - est.tradeCostsUsd - est.gasCostUsd, 6);
  });
});
