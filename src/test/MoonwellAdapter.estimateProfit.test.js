import { describe, it, expect, vi } from 'vitest';
import { MoonwellAdapter } from '../../adapters/MoonwellAdapter.js';
import { TOKENS_BASE } from '../../config/uniswap.js';

const COMPTROLLER = '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C';
const ORACLE      = '0xeeee000000000000000000000000000000000099';

const MWETH  = { symbol: 'mWETH',  address: '0x1111111111111111111111111111111111111111', underlying: 'WETH' };
const MUSDC  = { symbol: 'mUSDC',  address: '0x2222222222222222222222222222222222222222', underlying: 'USDC' };
const MCBBTC = { symbol: 'mcbBTC', address: '0x3333333333333333333333333333333333333333', underlying: 'cbBTC' };
const MTOKENS = [MWETH, MUSDC, MCBBTC];

const WAD = 1_000_000_000_000_000_000n;

const CLOSE_FACTOR_50 = WAD / 2n;                 // 0.5e18
const INCENTIVE_8     = WAD + WAD * 8n / 100n;    // 1.08e18

// Prices in Compound oracle convention: 1e36 / underlyingDecimals.
const USDC_PRICE_1USD     = 10n ** 30n;                 // 1 USD * 1e30 (USDC has 6 dec)
const WETH_PRICE_3000USD  = 3000n * WAD;                // 3000 USD * 1e18 (WETH has 18 dec)
const CBBTC_PRICE_60K     = 60_000n * 10n ** 28n;       // 60k USD * 1e28 (cbBTC has 8 dec)

function ok(result) { return { status: 'success', result }; }
function fail(error = new Error('reverted')) { return { status: 'failure', error }; }

// Pre-populated metadata map keyed by lowercase mToken. Avoids the on-chain
// underlying()/decimals() multicalls during tests so we can mock just the
// price/exchangeRate path.
function metaFor(mTokens) {
  const map = new Map();
  for (const m of mTokens) {
    const underlying = TOKENS_BASE[m.underlying];
    if (!underlying) throw new Error(`metaFor: no TOKENS_BASE entry for ${m.underlying}`);
    const decimals = m.underlying === 'USDC' || m.underlying === 'USDbC' || m.underlying === 'EURC' ? 6
      : m.underlying === 'cbBTC' ? 8
      : 18;
    map.set(m.address.toLowerCase(), { underlying, decimals, symbol: m.symbol });
  }
  return map;
}

function buildAdapter({ multicall, getGasPrice, mTokens = MTOKENS, gasEstimate = 750_000n } = {}) {
  const client = {
    multicall: multicall ?? vi.fn(),
    getGasPrice: getGasPrice ?? vi.fn().mockResolvedValue(0n),
    getBlockNumber: vi.fn().mockResolvedValue(0n),
    getLogs: vi.fn().mockResolvedValue([]),
  };
  const adapter = new MoonwellAdapter({
    client,
    comptroller: COMPTROLLER,
    mTokens,
    deployBlock: 0n,
    gasEstimate,
  });
  // Skip the underlying()+decimals() bootstrap multicalls — we don't want
  // tests to babysit two extra mock calls just to get to profit math.
  adapter._tokenMeta = metaFor(mTokens);
  return adapter;
}

function defaultParamsCall() {
  // allowFailure:false ⇒ raw array
  return [CLOSE_FACTOR_50, INCENTIVE_8, ORACLE];
}

describe('MoonwellAdapter.estimateProfit', () => {
  it('computes profit = effectiveRepay * bonus, with collateral abundant', async () => {
    const position = {
      protocol: 'moonwell',
      borrower: '0xbeef000000000000000000000000000000000001',
      shortfall: 100n,
      liquidity: 0n,
      // 1000 USDC of debt (USDC has 6 decimals → raw amount 1e9)
      debts: [{ mToken: MUSDC.address, symbol: 'mUSDC', amount: 1_000_000_000n }],
      // 1 WETH of collateral as cTokens. With exchangeRate=1e18 the cToken amount
      // and the underlying amount are 1:1 by raw unit.
      collaterals: [{ mToken: MWETH.address, symbol: 'mWETH', cTokenAmount: WAD }],
    };

    const multicall = vi.fn()
      .mockResolvedValueOnce(defaultParamsCall())
      // Phase 2: prices for [USDC, WETH] (set order from position.debts ∪ collaterals,
      // plus mWETH for gas — but mWETH is already in collaterals so no dup).
      // exchangeRates for collaterals [WETH].
      .mockResolvedValueOnce([
        ok(USDC_PRICE_1USD),     // priceList[0] = mUSDC (debt)
        ok(WETH_PRICE_3000USD),  // priceList[1] = mWETH (collateral, also gas)
        ok(WAD),                  // exchangeRateStored(mWETH) = 1e18 → 1:1
      ]);

    const adapter = buildAdapter({
      multicall,
      getGasPrice: vi.fn().mockResolvedValue(100_000_000n), // 0.1 gwei
    });

    const r = await adapter.estimateProfit(position);

    // Debt USD = 1e9 * 1e30 / 1e18 = 1e21 = 1000 USD
    // maxRepay = 500 USD; collateralUsd = 3000 USD; collateral can absorb full 500.
    // Gross profit = 500 * 0.08 = $40.
    // Trade costs at $500 effective repay:
    //   aave premium  = 5 bps  = $0.25
    //   pool fee WETH↔USDC tier=500 → 5 bps = $0.25
    //   slippage tight pair = 15 bps = $0.75
    //   total = $1.25
    // Gas = 0.1 gwei * 750_000 * 3000 USD/ETH = 0.225 USD.
    expect(r.profitUsd).toBeCloseTo(40, 6);
    expect(r.gasCostUsd).toBeCloseTo(0.225, 6);
    expect(r.netUsd).toBeCloseTo(40 - 1.25 - 0.225, 4);
    expect(r.swapPath).toBeDefined();
    expect(r.swapPath).not.toBe('0x');
  });

  it('caps repay by available collateral when collateral is small', async () => {
    const position = {
      protocol: 'moonwell',
      borrower: '0xbeef000000000000000000000000000000000002',
      shortfall: 1n,
      liquidity: 0n,
      // 1000 USDC debt (would allow 500 USD repay before cap)
      debts: [{ mToken: MUSDC.address, symbol: 'mUSDC', amount: 1_000_000_000n }],
      // Only 0.01 WETH of collateral worth $30
      collaterals: [{ mToken: MWETH.address, symbol: 'mWETH', cTokenAmount: WAD / 100n }],
    };

    const multicall = vi.fn()
      .mockResolvedValueOnce(defaultParamsCall())
      .mockResolvedValueOnce([
        ok(USDC_PRICE_1USD),
        ok(WETH_PRICE_3000USD),
        ok(WAD), // exchangeRate for mWETH
      ]);

    const adapter = buildAdapter({ multicall });
    const r = await adapter.estimateProfit(position);

    // collateralUsd = 30 USD; collCappedRepay = 30 / 1.08 ≈ 27.7777
    // gross profit ≈ 27.7777 * 0.08 ≈ 2.22222
    expect(r.profitUsd).toBeCloseTo(2.22222, 4);
  });

  it('picks the (debt, collateral) pair that maximises profit', async () => {
    const position = {
      protocol: 'moonwell',
      borrower: '0xbeef000000000000000000000000000000000003',
      shortfall: 1n,
      liquidity: 0n,
      debts: [
        { mToken: MUSDC.address,  symbol: 'mUSDC',  amount: 100_000_000n },     // $100 debt
        { mToken: MCBBTC.address, symbol: 'mcbBTC', amount: 10_000_000n },      // 0.1 cbBTC ≈ $6000 debt
      ],
      collaterals: [
        { mToken: MWETH.address, symbol: 'mWETH', cTokenAmount: WAD * 10n }, // ~$30k collateral
      ],
    };

    const multicall = vi.fn()
      .mockResolvedValueOnce(defaultParamsCall())
      // priceList = unique(debts ∪ collaterals ∪ [mWETH]) preserving Set iteration order:
      // mUSDC, mcbBTC, mWETH
      .mockResolvedValueOnce([
        ok(USDC_PRICE_1USD),     // mUSDC
        ok(CBBTC_PRICE_60K),     // mcbBTC
        ok(WETH_PRICE_3000USD),  // mWETH
        ok(WAD),                  // exchangeRate(mWETH)
      ]);

    const adapter = buildAdapter({ multicall });
    const r = await adapter.estimateProfit(position);

    // Best: cbBTC debt = $6000 → maxRepay $3000 → gross profit $240.
    // Worse: USDC debt = $100 → maxRepay $50 → gross profit $4.
    // Trade costs on cbBTC pair are higher (~$15) but $225 net still beats USDC's $3.99.
    expect(r.profitUsd).toBeCloseTo(240, 6);
  });

  it('netUsd goes negative when gas wipes out the bonus', async () => {
    const position = {
      protocol: 'moonwell',
      borrower: '0xbeef000000000000000000000000000000000004',
      shortfall: 1n,
      liquidity: 0n,
      debts: [{ mToken: MUSDC.address, symbol: 'mUSDC', amount: 1_000_000_000n }],
      collaterals: [{ mToken: MWETH.address, symbol: 'mWETH', cTokenAmount: WAD / 100n }], // $30
    };

    const multicall = vi.fn()
      .mockResolvedValueOnce(defaultParamsCall())
      .mockResolvedValueOnce([
        ok(USDC_PRICE_1USD),
        ok(WETH_PRICE_3000USD),
        ok(WAD),
      ]);

    const adapter = buildAdapter({
      multicall,
      // 10 gwei → gas $22.5 against $2.22 gross profit
      getGasPrice: vi.fn().mockResolvedValue(10_000_000_000n),
    });

    const r = await adapter.estimateProfit(position);
    expect(r.profitUsd).toBeCloseTo(2.22222, 4);
    expect(r.gasCostUsd).toBeCloseTo(22.5, 4);
    expect(r.netUsd).toBeLessThan(0);
    // Trade costs at $27.7778 effective repay: premium=$0.01389, pool fee=$0.01389,
    // slippage=$0.04167 → ~$0.06944. net = 2.22222 − 0.06944 − 22.5 ≈ −20.34722.
    expect(r.netUsd).toBeCloseTo(-20.34722, 4);
  });

  it('skips pairs whose oracle price or exchangeRate is missing', async () => {
    const position = {
      protocol: 'moonwell',
      borrower: '0xbeef000000000000000000000000000000000005',
      shortfall: 1n,
      liquidity: 0n,
      debts: [
        { mToken: MUSDC.address,  symbol: 'mUSDC',  amount: 1_000_000_000n },
        { mToken: MCBBTC.address, symbol: 'mcbBTC', amount: 10_000_000n },
      ],
      collaterals: [{ mToken: MWETH.address, symbol: 'mWETH', cTokenAmount: WAD }],
    };

    const multicall = vi.fn()
      .mockResolvedValueOnce(defaultParamsCall())
      .mockResolvedValueOnce([
        ok(USDC_PRICE_1USD),     // mUSDC ok
        fail(),                   // mcbBTC oracle reverted
        ok(WETH_PRICE_3000USD),  // mWETH ok
        ok(WAD),                  // exchangeRate(mWETH) ok
      ]);

    const adapter = buildAdapter({ multicall });
    const r = await adapter.estimateProfit(position);

    // cbBTC pair skipped; USDC pair only ⇒ gross profit ~$40.
    expect(r.profitUsd).toBeCloseTo(40, 6);
  });

  it('reports gasCostUsd=0 when no WETH market is configured', async () => {
    const position = {
      protocol: 'moonwell',
      borrower: '0xbeef000000000000000000000000000000000006',
      shortfall: 1n,
      liquidity: 0n,
      debts: [{ mToken: MUSDC.address, symbol: 'mUSDC', amount: 1_000_000_000n }],
      collaterals: [{ mToken: MCBBTC.address, symbol: 'mcbBTC', cTokenAmount: 100_000_000n }],
    };

    // Only MUSDC + MCBBTC in config — no WETH market at all.
    const mTokensNoWeth = [MUSDC, MCBBTC];

    const multicall = vi.fn()
      .mockResolvedValueOnce(defaultParamsCall())
      .mockResolvedValueOnce([
        ok(USDC_PRICE_1USD),
        ok(CBBTC_PRICE_60K),
        ok(WAD),  // exchangeRate(mcbBTC)
      ]);
    const getGasPrice = vi.fn().mockResolvedValue(10_000_000_000n);

    const adapter = buildAdapter({ multicall, getGasPrice, mTokens: mTokensNoWeth });
    const r = await adapter.estimateProfit(position);

    expect(r.gasCostUsd).toBe(0);
    // getGasPrice should not even be called since there's no way to convert.
    expect(getGasPrice).not.toHaveBeenCalled();
    // Gross profit math still works: $1000 USDC debt → $500 max repay → $40 profit.
    expect(r.profitUsd).toBeCloseTo(40, 6);
    // Trade costs at $500 repay on USDC↔cbBTC direct (3000 tier = 30 bps):
    //   premium=$0.25, pool fee=$1.50, slippage tight=15 bps=$0.75 → $2.50
    expect(r.netUsd).toBeCloseTo(40 - 2.5, 4);
  });

  it('returns zero profit for an empty position', async () => {
    const position = {
      protocol: 'moonwell',
      borrower: '0xbeef000000000000000000000000000000000007',
      shortfall: 0n,
      liquidity: 0n,
      debts: [],
      collaterals: [],
    };

    const multicall = vi.fn()
      .mockResolvedValueOnce(defaultParamsCall())
      .mockResolvedValueOnce([
        ok(WETH_PRICE_3000USD), // only mWETH for gas
      ]);
    const adapter = buildAdapter({
      multicall,
      getGasPrice: vi.fn().mockResolvedValue(100_000_000n),
    });

    const r = await adapter.estimateProfit(position);
    expect(r.profitUsd).toBe(0);
    expect(r.gasCostUsd).toBeCloseTo(0.225, 6);
    expect(r.netUsd).toBeCloseTo(-0.225, 6);
  });
});
