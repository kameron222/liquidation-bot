import { describe, it, expect, vi } from 'vitest';
import { MoonwellAdapter } from '../../adapters/MoonwellAdapter.js';

const COMPTROLLER = '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C';
const MTOKEN_A = { symbol: 'mA', address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', underlying: 'A' };
const MTOKEN_B = { symbol: 'mB', address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', underlying: 'B' };

const BORROWER_1 = '0x1111111111111111111111111111111111111111';
const BORROWER_2 = '0x2222222222222222222222222222222222222222';

function mockClient({ head, logsByCall }) {
  const getLogs = vi.fn();
  for (const logs of logsByCall) getLogs.mockResolvedValueOnce(logs);
  return {
    getBlockNumber: vi.fn().mockResolvedValue(head),
    getLogs,
  };
}

describe('MoonwellAdapter', () => {
  describe('constructor', () => {
    it('requires comptroller', () => {
      expect(() => new MoonwellAdapter({})).toThrow(/comptroller required/);
    });

    it('requires mTokens', () => {
      expect(() => new MoonwellAdapter({ comptroller: COMPTROLLER }))
        .toThrow(/mTokens required/);
    });

    it('requires either client or rpcUrl', () => {
      expect(() => new MoonwellAdapter({
        comptroller: COMPTROLLER,
        mTokens: [MTOKEN_A],
      })).toThrow(/client or rpcUrl required/);
    });

    it('defaults deployBlock to 0n and logChunk to 10000n', () => {
      const a = new MoonwellAdapter({
        client: { getBlockNumber: vi.fn(), getLogs: vi.fn() },
        comptroller: COMPTROLLER,
        mTokens: [MTOKEN_A],
      });
      expect(a.deployBlock).toBe(0n);
      expect(a.logChunk).toBe(10_000n);
      expect(a.borrowers.size).toBe(0);
    });
  });

  describe('indexBorrowers', () => {
    it('chunks log scans and dedups borrowers across mTokens', async () => {
      // Scan range 0 -> 25_000 with chunk 10_000 produces 3 calls per mToken:
      //   [0, 9999], [10000, 19999], [20000, 25000]
      const client = mockClient({
        head: 25_000n,
        logsByCall: [
          // mTokenA chunks
          [{ args: { borrower: BORROWER_1 } }],
          [],
          [{ args: { borrower: BORROWER_2 } }],
          // mTokenB chunks
          [{ args: { borrower: BORROWER_1 } }], // dup across mTokens
          [],
          [],
        ],
      });

      const adapter = new MoonwellAdapter({
        client,
        comptroller: COMPTROLLER,
        mTokens: [MTOKEN_A, MTOKEN_B],
        deployBlock: 0n,
        logChunk: 10_000n,
      });

      const result = await adapter.indexBorrowers();

      expect(result.borrowerCount).toBe(2);
      expect(result.scannedToBlock).toBe(25_000n);
      expect(adapter.borrowers.has(BORROWER_1)).toBe(true);
      expect(adapter.borrowers.has(BORROWER_2)).toBe(true);
      expect(client.getLogs).toHaveBeenCalledTimes(6);

      const firstCall = client.getLogs.mock.calls[0][0];
      expect(firstCall.address).toBe(MTOKEN_A.address);
      expect(firstCall.fromBlock).toBe(0n);
      expect(firstCall.toBlock).toBe(9_999n);
    });

    it('handles a single-block range with one getLogs call', async () => {
      const client = mockClient({ head: 0n, logsByCall: [[]] });

      const adapter = new MoonwellAdapter({
        client,
        comptroller: COMPTROLLER,
        mTokens: [MTOKEN_A],
        deployBlock: 0n,
      });

      const result = await adapter.indexBorrowers();

      expect(result.borrowerCount).toBe(0);
      expect(client.getLogs).toHaveBeenCalledTimes(1);
      expect(client.getLogs.mock.calls[0][0]).toMatchObject({
        fromBlock: 0n,
        toBlock: 0n,
      });
    });

    it('is idempotent — re-running merges into the existing cache', async () => {
      const client = mockClient({
        head: 100n,
        logsByCall: [
          [{ args: { borrower: BORROWER_1 } }],
          [{ args: { borrower: BORROWER_1 } }, { args: { borrower: BORROWER_2 } }],
        ],
      });

      const adapter = new MoonwellAdapter({
        client,
        comptroller: COMPTROLLER,
        mTokens: [MTOKEN_A],
        deployBlock: 0n,
        logChunk: 10_000n,
      });

      await adapter.indexBorrowers();
      expect(adapter.borrowers.size).toBe(1);

      await adapter.indexBorrowers();
      expect(adapter.borrowers.size).toBe(2);
    });
  });
});
