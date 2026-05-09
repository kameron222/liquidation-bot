import { describe, it, expect, vi } from 'vitest';
import { MoonwellAdapter } from '../../adapters/MoonwellAdapter.js';

const COMPTROLLER = '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C';
const MWETH  = { symbol: 'mWETH', address: '0x628ff693426583D9a7FB391E54366292F509D457', underlying: 'WETH' };
const MUSDC  = { symbol: 'mUSDC', address: '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22', underlying: 'USDC' };
const MTOKENS = [MWETH, MUSDC];

const HEALTHY  = '0xaaaa000000000000000000000000000000000001';
const UNHEALTHY = '0xbbbb000000000000000000000000000000000002';
const STALE     = '0xcccc000000000000000000000000000000000003'; // shortfall=0 too

function ok(result) { return { status: 'success', result }; }
function fail(error = new Error('reverted')) { return { status: 'failure', error }; }

function buildAdapter({ multicall, getBlockNumber, getLogs } = {}) {
  const client = {
    multicall: multicall ?? vi.fn(),
    getBlockNumber: getBlockNumber ?? vi.fn().mockResolvedValue(0n),
    getLogs: getLogs ?? vi.fn().mockResolvedValue([]),
  };
  return new MoonwellAdapter({
    client,
    comptroller: COMPTROLLER,
    mTokens: MTOKENS,
    deployBlock: 0n,
  });
}

describe('MoonwellAdapter.getLiquidatable', () => {
  it('returns [] when there are no cached borrowers', async () => {
    const adapter = buildAdapter();
    const result = await adapter.getLiquidatable();
    expect(result).toEqual([]);
    expect(adapter.client.multicall).not.toHaveBeenCalled();
  });

  it('returns [] when every borrower is solvent', async () => {
    const multicall = vi.fn().mockResolvedValueOnce([
      ok([0n, 1_000n, 0n]), // (error, liquidity, shortfall)
      ok([0n, 500n, 0n]),
    ]);
    const adapter = buildAdapter({ multicall });
    adapter.borrowers.add(HEALTHY);
    adapter.borrowers.add(STALE);

    const result = await adapter.getLiquidatable();
    expect(result).toEqual([]);
    expect(multicall).toHaveBeenCalledTimes(1); // only the shortfall check
  });

  it('builds a Position with debts + collaterals for an unhealthy borrower', async () => {
    const multicall = vi.fn()
      // Phase 1: getAccountLiquidity for [HEALTHY, UNHEALTHY]
      .mockResolvedValueOnce([
        ok([0n, 1_000n, 0n]),
        ok([0n, 0n, 250n]),
      ])
      // Phase 2: getAssetsIn for liquidatable subset [UNHEALTHY]
      .mockResolvedValueOnce([
        ok([MWETH.address, MUSDC.address]),
      ])
      // Phase 3: per-(borrower, mToken): borrowBalanceCurrent + balanceOf
      .mockResolvedValueOnce([
        ok(0n),       // mWETH.borrowBalanceCurrent — no debt here
        ok(2_500_000n), // mWETH.balanceOf — collateral
        ok(800n),     // mUSDC.borrowBalanceCurrent — debt
        ok(0n),       // mUSDC.balanceOf — no collateral
      ]);

    const adapter = buildAdapter({ multicall });
    adapter.borrowers.add(HEALTHY);
    adapter.borrowers.add(UNHEALTHY);

    const result = await adapter.getLiquidatable();

    expect(multicall).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      protocol: 'moonwell',
      borrower: UNHEALTHY,
      shortfall: 250n,
      liquidity: 0n,
    });
    expect(result[0].debts).toEqual([
      { mToken: MUSDC.address, symbol: 'mUSDC', amount: 800n },
    ]);
    expect(result[0].collaterals).toEqual([
      { mToken: MWETH.address, symbol: 'mWETH', cTokenAmount: 2_500_000n },
    ]);
  });

  it('skips borrowers whose getAccountLiquidity errors or returns nonzero error code', async () => {
    const multicall = vi.fn()
      .mockResolvedValueOnce([
        fail(),                  // RPC failure
        ok([1n, 0n, 999n]),       // nonzero error code (Comptroller error)
        ok([0n, 0n, 100n]),       // valid shortfall
      ])
      .mockResolvedValueOnce([ok([])])              // empty assetsIn
      .mockResolvedValueOnce([]);                    // no balance calls
    const adapter = buildAdapter({ multicall });
    adapter.borrowers.add(HEALTHY);
    adapter.borrowers.add(STALE);
    adapter.borrowers.add(UNHEALTHY);

    const result = await adapter.getLiquidatable();
    // Only UNHEALTHY survives; assetsIn empty ⇒ no balance multicall is issued.
    expect(multicall).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0].borrower).toBe(UNHEALTHY);
    expect(result[0].debts).toEqual([]);
    expect(result[0].collaterals).toEqual([]);
  });

  it('survives partial failures in the balance phase', async () => {
    const multicall = vi.fn()
      .mockResolvedValueOnce([ok([0n, 0n, 50n])])
      .mockResolvedValueOnce([ok([MWETH.address])])
      .mockResolvedValueOnce([
        fail(),     // borrowBalanceCurrent reverted
        ok(42n),    // balanceOf still works
      ]);
    const adapter = buildAdapter({ multicall });
    adapter.borrowers.add(UNHEALTHY);

    const result = await adapter.getLiquidatable();
    expect(result[0].debts).toEqual([]);
    expect(result[0].collaterals).toEqual([
      { mToken: MWETH.address, symbol: 'mWETH', cTokenAmount: 42n },
    ]);
  });

  it('labels mTokens not in our config as "?"', async () => {
    const UNKNOWN_MTOKEN = '0xdead000000000000000000000000000000000099';
    const multicall = vi.fn()
      .mockResolvedValueOnce([ok([0n, 0n, 1n])])
      .mockResolvedValueOnce([ok([UNKNOWN_MTOKEN])])
      .mockResolvedValueOnce([ok(7n), ok(0n)]);
    const adapter = buildAdapter({ multicall });
    adapter.borrowers.add(UNHEALTHY);

    const result = await adapter.getLiquidatable();
    expect(result[0].debts[0].symbol).toBe('?');
    expect(result[0].debts[0].mToken).toBe(UNKNOWN_MTOKEN);
  });
});
