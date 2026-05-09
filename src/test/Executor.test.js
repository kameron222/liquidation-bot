import { describe, it, expect, vi } from 'vitest';
import { Executor, GasOverCapError, StaleCandidateError } from '../../core/Executor.js';

const ACCOUNT = '0x000000000000000000000000000000000000A11C';
const TO      = '0xC0FFee0000000000000000000000000000000000';
const DATA    = '0xdeadbeef';
const TX_HASH = '0x1111111111111111111111111111111111111111111111111111111111111111';
const GWEI    = 1_000_000_000n;

function buildClients({
  baseFee   = 2n * GWEI,             // 2 gwei base
  estimate  = 700_000n,
  estimateError = null,
  receiptStatus = 'success',
  gasUsed   = 650_000n,
} = {}) {
  const publicClient = {
    getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: baseFee }),
    estimateGas: estimateError
      ? vi.fn().mockRejectedValue(estimateError)
      : vi.fn().mockResolvedValue(estimate),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: receiptStatus, gasUsed }),
  };
  const walletClient = {
    account: { address: ACCOUNT },
    sendTransaction: vi.fn().mockResolvedValue(TX_HASH),
  };
  return { publicClient, walletClient };
}

describe('Executor', () => {
  it('signs+sends with EIP-1559 fields and returns receipt summary on success', async () => {
    const { publicClient, walletClient } = buildClients({ baseFee: 2n * GWEI });
    const exec = new Executor({ publicClient, walletClient, maxGasGwei: 50, priorityFeeGwei: 1 });

    const result = await exec.run({ to: TO, data: DATA });

    expect(result.txHash).toBe(TX_HASH);
    expect(result.status).toBe('success');
    expect(result.gasUsed).toBe(650_000n);
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);
    const sentTx = walletClient.sendTransaction.mock.calls[0][0];
    expect(sentTx.to).toBe(TO);
    expect(sentTx.data).toBe(DATA);
    // 700k * 1.2 = 840k
    expect(sentTx.gas).toBe(840_000n);
    expect(sentTx.value).toBe(0n);
    // EIP-1559 fields: priority = 1 gwei, maxFee = 2*baseFee + priority = 5 gwei
    expect(sentTx.maxPriorityFeePerGas).toBe(GWEI);
    expect(sentTx.maxFeePerGas).toBe(5n * GWEI);
  });

  it('throws GasOverCapError without sending when 2*baseFee+priority exceeds cap', async () => {
    // baseFee 30 gwei → maxFee = 61 gwei > cap 50 gwei.
    const { publicClient, walletClient } = buildClients({ baseFee: 30n * GWEI });
    const exec = new Executor({ publicClient, walletClient, maxGasGwei: 50, priorityFeeGwei: 1 });

    await expect(exec.run({ to: TO, data: DATA })).rejects.toBeInstanceOf(GasOverCapError);
    expect(walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('throws StaleCandidateError without sending when estimateGas reverts', async () => {
    const { publicClient, walletClient } = buildClients({
      estimateError: new Error('execution reverted'),
    });
    const exec = new Executor({ publicClient, walletClient, maxGasGwei: 50 });

    await expect(exec.run({ to: TO, data: DATA })).rejects.toBeInstanceOf(StaleCandidateError);
    expect(walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('passes through `value` when caller provides it', async () => {
    const { publicClient, walletClient } = buildClients();
    const exec = new Executor({ publicClient, walletClient, maxGasGwei: 50 });
    await exec.run({ to: TO, data: DATA, value: 42n });
    expect(walletClient.sendTransaction.mock.calls[0][0].value).toBe(42n);
  });

  it('dry-run skips sendTransaction and returns a synthetic success receipt', async () => {
    const { publicClient, walletClient } = buildClients();
    const exec = new Executor({ publicClient, walletClient, maxGasGwei: 50, dryRun: true });

    const result = await exec.run({ to: TO, data: DATA });

    expect(walletClient.sendTransaction).not.toHaveBeenCalled();
    expect(publicClient.waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(result.status).toBe('success');
    expect(result.dryRun).toBe(true);
    expect(result.txHash).toMatch(/^0x[0-9a-f]+dead$/);
  });
});

describe('Executor.runMany', () => {
  it('sends N calls in parallel with sequential nonces from pending count', async () => {
    const publicClient = {
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 2n * GWEI }),
      estimateGas: vi.fn().mockResolvedValue(500_000n),
      getTransactionCount: vi.fn().mockResolvedValue(42),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success', gasUsed: 480_000n }),
    };
    const walletClient = {
      account: { address: ACCOUNT },
      sendTransaction: vi.fn()
        .mockResolvedValueOnce('0xaaa')
        .mockResolvedValueOnce('0xbbb')
        .mockResolvedValueOnce('0xccc'),
    };
    const exec = new Executor({ publicClient, walletClient, maxGasGwei: 50 });

    const results = await exec.runMany([
      { to: TO, data: '0x01' },
      { to: TO, data: '0x02' },
      { to: TO, data: '0x03' },
    ]);

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.txHash)).toEqual(['0xaaa', '0xbbb', '0xccc']);
    expect(results.map((r) => r.nonce)).toEqual([42, 43, 44]);
    expect(publicClient.getTransactionCount).toHaveBeenCalledTimes(1);
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(3);
  });

  it('returns an in-band StaleCandidateError when one estimate reverts; survivors send', async () => {
    const publicClient = {
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 2n * GWEI }),
      estimateGas: vi.fn()
        .mockResolvedValueOnce(500_000n)
        .mockRejectedValueOnce(new Error('execution reverted'))
        .mockResolvedValueOnce(500_000n),
      getTransactionCount: vi.fn().mockResolvedValue(7),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success', gasUsed: 480_000n }),
    };
    const walletClient = {
      account: { address: ACCOUNT },
      sendTransaction: vi.fn()
        .mockResolvedValueOnce('0xaaa')
        .mockResolvedValueOnce('0xccc'),
    };
    const exec = new Executor({ publicClient, walletClient, maxGasGwei: 50 });

    const results = await exec.runMany([
      { to: TO, data: '0x01' },
      { to: TO, data: '0x02' },
      { to: TO, data: '0x03' },
    ]);

    expect(results[0].txHash).toBe('0xaaa');
    expect(results[0].nonce).toBe(7);
    expect(results[1].error).toBeInstanceOf(StaleCandidateError);
    expect(results[2].txHash).toBe('0xccc');
    // Only 2 sends — survivors use nonces 7 and 8 (not 7 and 9).
    expect(results[2].nonce).toBe(8);
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it('throws GasOverCapError for the whole batch when over cap', async () => {
    const publicClient = {
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 30n * GWEI }),
      estimateGas: vi.fn(),
      getTransactionCount: vi.fn(),
      waitForTransactionReceipt: vi.fn(),
    };
    const walletClient = { account: { address: ACCOUNT }, sendTransaction: vi.fn() };
    const exec = new Executor({ publicClient, walletClient, maxGasGwei: 50, priorityFeeGwei: 1 });

    await expect(exec.runMany([{ to: TO, data: '0x01' }, { to: TO, data: '0x02' }]))
      .rejects.toBeInstanceOf(GasOverCapError);
    expect(walletClient.sendTransaction).not.toHaveBeenCalled();
    expect(publicClient.getTransactionCount).not.toHaveBeenCalled();
  });

  it('falls through to single run() for length-1 input', async () => {
    const { publicClient, walletClient } = buildClients();
    const exec = new Executor({ publicClient, walletClient, maxGasGwei: 50 });

    const results = await exec.runMany([{ to: TO, data: DATA }]);
    expect(results).toHaveLength(1);
    expect(results[0].txHash).toBe(TX_HASH);
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);
    // No nonce read in length-1 path — single run() doesn't need it.
    expect(walletClient.sendTransaction.mock.calls[0][0].nonce).toBeUndefined();
  });

  it('returns [] for empty input without any RPC calls', async () => {
    const { publicClient, walletClient } = buildClients();
    const exec = new Executor({ publicClient, walletClient, maxGasGwei: 50 });
    const results = await exec.runMany([]);
    expect(results).toEqual([]);
    expect(publicClient.getBlock).not.toHaveBeenCalled();
  });
});

describe('Executor adaptive priority fee', () => {
  it('bumps 50% only after two consecutive reverts; one revert does not bump', async () => {
    const publicClient = {
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 2n * GWEI }),
      estimateGas: vi.fn().mockResolvedValue(500_000n),
      waitForTransactionReceipt: vi.fn()
        .mockResolvedValueOnce({ status: 'reverted', gasUsed: 480_000n })
        .mockResolvedValueOnce({ status: 'reverted', gasUsed: 480_000n })
        .mockResolvedValueOnce({ status: 'success',  gasUsed: 480_000n }),
    };
    const walletClient = {
      account: { address: ACCOUNT },
      sendTransaction: vi.fn().mockResolvedValue(TX_HASH),
    };
    const exec = new Executor({ publicClient, walletClient, maxGasGwei: 50, priorityFeeGwei: 1 });

    await exec.run({ to: TO, data: DATA });
    expect(walletClient.sendTransaction.mock.calls[0][0].maxPriorityFeePerGas).toBe(GWEI);

    await exec.run({ to: TO, data: DATA });
    expect(walletClient.sendTransaction.mock.calls[1][0].maxPriorityFeePerGas).toBe(GWEI);

    // After 2 reverts, priority fee is bumped for the *next* tx.
    await exec.run({ to: TO, data: DATA });
    expect(walletClient.sendTransaction.mock.calls[2][0].maxPriorityFeePerGas).toBe(1_500_000_000n);
  });

  it('decays toward base after success, floors at base', async () => {
    const publicClient = {
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 2n * GWEI }),
      estimateGas: vi.fn().mockResolvedValue(500_000n),
      waitForTransactionReceipt: vi.fn()
        .mockResolvedValueOnce({ status: 'reverted', gasUsed: 480_000n })
        .mockResolvedValueOnce({ status: 'reverted', gasUsed: 480_000n })
        .mockResolvedValueOnce({ status: 'success',  gasUsed: 480_000n })
        .mockResolvedValueOnce({ status: 'success',  gasUsed: 480_000n })
        .mockResolvedValueOnce({ status: 'success',  gasUsed: 480_000n }),
    };
    const walletClient = {
      account: { address: ACCOUNT },
      sendTransaction: vi.fn().mockResolvedValue(TX_HASH),
    };
    const exec = new Executor({ publicClient, walletClient, maxGasGwei: 50, priorityFeeGwei: 1 });

    await exec.run({ to: TO, data: DATA });
    await exec.run({ to: TO, data: DATA });
    // tx 3 sent at bumped fee 1.5 gwei; receipt success decays for tx 4.
    await exec.run({ to: TO, data: DATA });
    expect(walletClient.sendTransaction.mock.calls[2][0].maxPriorityFeePerGas).toBe(1_500_000_000n);

    // tx 4: 1.5 * 0.7 = 1.05 gwei (above base, no floor)
    await exec.run({ to: TO, data: DATA });
    expect(walletClient.sendTransaction.mock.calls[3][0].maxPriorityFeePerGas).toBe(1_050_000_000n);

    // tx 5: 1.05 * 0.7 = 0.735 gwei → floored to base 1 gwei
    await exec.run({ to: TO, data: DATA });
    expect(walletClient.sendTransaction.mock.calls[4][0].maxPriorityFeePerGas).toBe(GWEI);
  });

  it('caps bumped priority fee at maxGasWei/4', async () => {
    const publicClient = {
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 2n * GWEI }),
      estimateGas: vi.fn().mockResolvedValue(500_000n),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'reverted', gasUsed: 480_000n }),
    };
    const walletClient = {
      account: { address: ACCOUNT },
      sendTransaction: vi.fn().mockResolvedValue(TX_HASH),
    };
    // base 10 gwei, cap = 50/4 = 12.5 gwei. One bump (×1.5) → 15 gwei → cap to 12.5.
    const exec = new Executor({ publicClient, walletClient, maxGasGwei: 50, priorityFeeGwei: 10 });

    await exec.run({ to: TO, data: DATA }); // revert #1, no bump
    await exec.run({ to: TO, data: DATA }); // revert #2, bump for next call
    await exec.run({ to: TO, data: DATA });
    expect(walletClient.sendTransaction.mock.calls[2][0].maxPriorityFeePerGas).toBe(12_500_000_000n);

    // Further reverts stay at the cap.
    await exec.run({ to: TO, data: DATA });
    expect(walletClient.sendTransaction.mock.calls[3][0].maxPriorityFeePerGas).toBe(12_500_000_000n);
  });
});
