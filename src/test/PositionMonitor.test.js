import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PositionMonitor } from '../../core/PositionMonitor.js';
import { GasOverCapError } from '../../core/Executor.js';

const POS_A = {
  protocol: 'moonwell',
  borrower: '0xbeef000000000000000000000000000000000001',
  shortfall: 1n, liquidity: 0n, debts: [], collaterals: [],
};
const POS_B = {
  protocol: 'moonwell',
  borrower: '0xbeef000000000000000000000000000000000002',
  shortfall: 1n, liquidity: 0n, debts: [], collaterals: [],
};

function buildAdapter({ liquidatable = [], estimates = new Map(), call = { to: '0xC0Ffee0000000000000000000000000000000000', data: '0x', value: 0n } } = {}) {
  return {
    indexBorrowers:        vi.fn().mockResolvedValue({ borrowerCount: liquidatable.length, scannedToBlock: 0n }),
    getLiquidatable:       vi.fn().mockResolvedValue(liquidatable),
    estimateProfit:        vi.fn().mockImplementation(async (pos) => estimates.get(pos.borrower) ?? { profitUsd: 0, gasCostUsd: 0, netUsd: 0 }),
    buildLiquidationCall:  vi.fn().mockReturnValue(call),
  };
}

function buildNotifier() {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

function buildExecutor({ runMany } = {}) {
  return {
    runMany: runMany ?? vi.fn().mockImplementation(async (calls) =>
      calls.map((_, i) => ({ txHash: `0x${(0xabc + i).toString(16)}`, status: 'success', gasUsed: 600_000n, effectiveGasPrice: 5n * 10n ** 9n, nonce: i })),
    ),
  };
}

const noSleep = () => Promise.resolve();

describe('PositionMonitor.tick', () => {
  let notifier;
  beforeEach(() => { notifier = buildNotifier(); });

  it('skips positions that fail the minProfit threshold', async () => {
    const adapter = buildAdapter({
      liquidatable: [POS_A],
      estimates: new Map([[POS_A.borrower, { profitUsd: 5, gasCostUsd: 1, netUsd: 4 }]]),
    });
    const executor = buildExecutor();
    const monitor = new PositionMonitor({
      adapters: [adapter], executor, notifier,
      minProfitUsd: 10, pollIntervalMs: 1, sleep: noSleep,
    });

    await monitor.tick();
    expect(executor.runMany).not.toHaveBeenCalled();
    // Notifier shouldn't be called for sub-threshold candidates.
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('liquidates a profitable position and posts success', async () => {
    const adapter = buildAdapter({
      liquidatable: [POS_A],
      estimates: new Map([[POS_A.borrower, { profitUsd: 50, gasCostUsd: 2, netUsd: 48 }]]),
    });
    const executor = buildExecutor();
    const monitor = new PositionMonitor({
      adapters: [adapter], executor, notifier,
      minProfitUsd: 10, pollIntervalMs: 1, sleep: noSleep,
    });

    await monitor.tick();

    expect(adapter.buildLiquidationCall).toHaveBeenCalledTimes(1);
    expect(executor.runMany).toHaveBeenCalledTimes(1);
    const titles = notifier.send.mock.calls.map((c) => c[0].title);
    expect(titles).toContain('Candidate: $48.00 net');
    expect(titles.some((t) => t.startsWith('Liquidated $'))).toBe(true);
  });

  it('emits a warn when GasOverCapError is thrown', async () => {
    const overCap = new GasOverCapError({ gasPriceWei: 100n * 10n ** 9n, capWei: 50n * 10n ** 9n });
    const executor = buildExecutor({ runMany: vi.fn().mockRejectedValue(overCap) });
    const adapter = buildAdapter({
      liquidatable: [POS_A],
      estimates: new Map([[POS_A.borrower, { profitUsd: 50, gasCostUsd: 2, netUsd: 48 }]]),
    });
    const monitor = new PositionMonitor({
      adapters: [adapter], executor, notifier,
      minProfitUsd: 10, pollIntervalMs: 1, sleep: noSleep,
    });

    await monitor.tick();

    const calls = notifier.send.mock.calls.map((c) => c[0]);
    const warnCall = calls.find((c) => c.level === 'warn');
    expect(warnCall).toBeDefined();
    expect(warnCall.title).toBe('Skipped: gas over cap');
  });

  it('isolates per-position errors so other positions still execute', async () => {
    const adapter = buildAdapter({
      liquidatable: [POS_A, POS_B],
      estimates: new Map([
        [POS_A.borrower, { profitUsd: 50, gasCostUsd: 2, netUsd: 48 }],
        [POS_B.borrower, { profitUsd: 100, gasCostUsd: 2, netUsd: 98 }],
      ]),
    });
    // First entry returns an in-band send error; second succeeds.
    const executor = {
      runMany: vi.fn().mockResolvedValue([
        { error: new Error('first reverted') },
        { txHash: '0xdef', status: 'success', gasUsed: 600_000n, effectiveGasPrice: 5n * 10n ** 9n, nonce: 1 },
      ]),
    };
    const monitor = new PositionMonitor({
      adapters: [adapter], executor, notifier,
      minProfitUsd: 10, pollIntervalMs: 1, sleep: noSleep,
    });

    await monitor.tick();
    expect(executor.runMany).toHaveBeenCalledTimes(1);
    expect(executor.runMany.mock.calls[0][0]).toHaveLength(2);

    const sendErrors = notifier.send.mock.calls.filter((c) => c[0].level === 'error');
    expect(sendErrors).toHaveLength(1);
    const sendSuccess = notifier.send.mock.calls.filter((c) => c[0].level === 'success');
    expect(sendSuccess).toHaveLength(1);
  });

  it('reindexes every reindexEvery ticks (and not before)', async () => {
    const adapter = buildAdapter({ liquidatable: [] });
    const executor = buildExecutor();
    const monitor = new PositionMonitor({
      adapters: [adapter], executor, notifier,
      minProfitUsd: 10, pollIntervalMs: 1, reindexEvery: 3, sleep: noSleep,
    });

    // monitor.tick() does not increment _tickCount itself (start() does);
    // simulate the loop. With reindexEvery=3, we reindex when _tickCount is
    // 3 and 6 — i.e. on the 4th and 7th calls.
    for (let i = 0; i < 7; i++) {
      await monitor.tick();
      monitor._tickCount++;
    }
    expect(adapter.indexBorrowers).toHaveBeenCalledTimes(2);
  });
});

describe('PositionMonitor.start', () => {
  it('indexes once on start, posts the online embed, then stops on demand', async () => {
    const notifier = buildNotifier();
    const adapter = buildAdapter({ liquidatable: [] });
    const executor = buildExecutor();
    const monitor = new PositionMonitor({
      adapters: [adapter], executor, notifier,
      minProfitUsd: 10, pollIntervalMs: 1, sleep: noSleep,
    });

    // Stop after first tick to guarantee finite test.
    let ticks = 0;
    const origTick = monitor.tick.bind(monitor);
    monitor.tick = async () => {
      ticks++;
      if (ticks >= 1) await monitor.stop();
      return origTick();
    };

    await monitor.start();
    expect(adapter.indexBorrowers).toHaveBeenCalledTimes(1);
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({ title: 'Liquidation bot online' }));
  });
});
