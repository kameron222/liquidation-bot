import { describe, it, expect, vi } from 'vitest';
import { MorphoBlueAdapter } from '../../adapters/MorphoBlueAdapter.js';

const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const USDC   = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const cbETH  = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22';
const ORACLE = '0x4756c26E01E61c7c2F86b10f4316e179db8F9425';
const IRM    = '0x46415998764C29aB2a25CbeA6254146D50D22687';

const MARKET = {
  id: `0x${'11'.repeat(32)}`,
  name: 'cbETH/USDC (86%)',
  loanToken: USDC,
  collateralToken: cbETH,
  oracle: ORACLE,
  irm: IRM,
  lltv: 860_000_000_000_000_000n, // 86%
};

const HEALTHY   = '0xaaaa000000000000000000000000000000000001';
const UNHEALTHY = '0xbbbb000000000000000000000000000000000002';

// cbETH @ $3000, loan USDC (6dp), collateral cbETH (18dp).
// Morpho oracle scale = 1e36 * 10^(loanDec - collDec) = 1e24, so price = 3000e24.
const PRICE = 3_000_000_000_000_000_000_000_000_000n; // 3e27
const TOTAL_BORROW_ASSETS = 1_000_000_000_000n;       // 1e12 (1,000,000 USDC)
const TOTAL_BORROW_SHARES = 1_000_000_000_000_000_000n; // 1e18
const COLLATERAL = 1_000_000_000_000_000_000n;        // 1 cbETH

function ok(result) { return { status: 'success', result }; }
function fail(error = new Error('reverted')) { return { status: 'failure', error }; }

// market() tuple: [tSA, tSS, tBA, tBS, lastUpdate, fee]
const MARKET_STRUCT = [0n, 0n, TOTAL_BORROW_ASSETS, TOTAL_BORROW_SHARES, 0n, 0n];

function buildAdapter({ multicall } = {}) {
  const client = {
    multicall: multicall ?? vi.fn(),
    getBlockNumber: vi.fn().mockResolvedValue(0n),
    getLogs: vi.fn().mockResolvedValue([]),
    getGasPrice: vi.fn().mockResolvedValue(0n),
  };
  const adapter = new MorphoBlueAdapter({
    client,
    morpho: MORPHO,
    markets: [MARKET],
    accrueInterest: false, // deterministic: skip the borrowRateView multicall
    useQuoter: false,
  });
  adapter._marketsValidated = true; // bypass on-chain market validation
  return adapter;
}

describe('MorphoBlueAdapter.getLiquidatable', () => {
  it('returns [] when there are no cached borrowers', async () => {
    const adapter = buildAdapter();
    const result = await adapter.getLiquidatable();
    expect(result).toEqual([]);
  });

  it('flags a borrower whose accrued debt exceeds the LLTV-scaled collateral', async () => {
    const multicall = vi.fn()
      // _loadMarketState: [market(id), oracle.price()]
      .mockResolvedValueOnce([ok(MARKET_STRUCT), ok(PRICE)])
      // _filterUnhealthy: position(id, borrower) for [HEALTHY, UNHEALTHY]
      .mockResolvedValueOnce([
        ok([0n, 2_000_000_000_000_000n, COLLATERAL]), // ~2000 USDC debt → healthy
        ok([0n, 2_600_000_000_000_000n, COLLATERAL]), // ~2600 USDC debt → unhealthy (> 2580 max)
      ]);
    const adapter = buildAdapter({ multicall });
    adapter.borrowers.get(MARKET.id.toLowerCase()).add(HEALTHY);
    adapter.borrowers.get(MARKET.id.toLowerCase()).add(UNHEALTHY);

    const result = await adapter.getLiquidatable();

    expect(multicall).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      protocol: 'morpho',
      borrower: UNHEALTHY,
      collateral: COLLATERAL,
      collateralPrice: PRICE,
    });
    expect(result[0].market.id).toBe(MARKET.id);
    expect(result[0].borrowAssets).toBeGreaterThan(2_580_000_000n); // > 86% of $3000
  });

  it('skips borrowers with zero debt or zero collateral', async () => {
    const multicall = vi.fn()
      .mockResolvedValueOnce([ok(MARKET_STRUCT), ok(PRICE)])
      .mockResolvedValueOnce([
        ok([0n, 0n, COLLATERAL]),                       // no debt
        ok([0n, 2_600_000_000_000_000n, 0n]),           // no collateral
      ]);
    const adapter = buildAdapter({ multicall });
    adapter.borrowers.get(MARKET.id.toLowerCase()).add(HEALTHY);
    adapter.borrowers.get(MARKET.id.toLowerCase()).add(UNHEALTHY);

    const result = await adapter.getLiquidatable();
    expect(result).toEqual([]);
  });

  it('records a silent skip when a position() read fails', async () => {
    const multicall = vi.fn()
      .mockResolvedValueOnce([ok(MARKET_STRUCT), ok(PRICE)])
      .mockResolvedValueOnce([fail()]);
    const adapter = buildAdapter({ multicall });
    adapter.borrowers.get(MARKET.id.toLowerCase()).add(UNHEALTHY);

    const result = await adapter.getLiquidatable();
    expect(result).toEqual([]);
    const skips = adapter.drainSilentSkips();
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ borrower: UNHEALTHY, reason: 'position() read failed' });
  });

  it('drops the market for the tick when its market()/price() read fails', async () => {
    const multicall = vi.fn().mockResolvedValueOnce([fail(), fail()]);
    const adapter = buildAdapter({ multicall });
    adapter.borrowers.get(MARKET.id.toLowerCase()).add(UNHEALTHY);

    const result = await adapter.getLiquidatable();
    expect(result).toEqual([]);
    // No position multicall issued because the market state was unavailable.
    expect(multicall).toHaveBeenCalledTimes(1);
  });
});
