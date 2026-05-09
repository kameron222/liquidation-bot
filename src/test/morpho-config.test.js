import { describe, it, expect, vi } from 'vitest';
import { keccak256, encodeAbiParameters } from 'viem';
import { marketId, MORPHO_BASE } from '../../config/morpho.js';
import { MorphoBlueAdapter } from '../../adapters/MorphoBlueAdapter.js';

const USDC  = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const cbETH = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22';
const ORACLE = '0x4756c26E01E61c7c2F86b10f4316e179db8F9425';
const IRM    = '0x46415998764C29aB2a25CbeA6254146D50D22687';

function ok(result) { return { status: 'success', result }; }
function fail() { return { status: 'failure', error: new Error('x') }; }

describe('marketId', () => {
  it('matches keccak256(abi.encode(MarketParams))', () => {
    const params = { loanToken: USDC, collateralToken: cbETH, oracle: ORACLE, irm: IRM, lltv: 860_000_000_000_000_000n };
    const expected = keccak256(encodeAbiParameters(
      [{ type: 'tuple', components: [
        { name: 'loanToken', type: 'address' }, { name: 'collateralToken', type: 'address' },
        { name: 'oracle', type: 'address' }, { name: 'irm', type: 'address' }, { name: 'lltv', type: 'uint256' },
      ] }],
      [params],
    ));
    expect(marketId(params)).toBe(expected);
  });

  it('is sensitive to every field', () => {
    const base = { loanToken: USDC, collateralToken: cbETH, oracle: ORACLE, irm: IRM, lltv: 860_000_000_000_000_000n };
    const id = marketId(base);
    expect(marketId({ ...base, lltv: 770_000_000_000_000_000n })).not.toBe(id);
    expect(marketId({ ...base, oracle: IRM })).not.toBe(id);
  });

  it('every configured market carries a derived id', () => {
    for (const m of MORPHO_BASE.markets) {
      expect(m.id).toBe(marketId(m));
    }
  });
});

describe('MorphoBlueAdapter._validateMarkets', () => {
  const MARKET = {
    id: marketId({ loanToken: USDC, collateralToken: cbETH, oracle: ORACLE, irm: IRM, lltv: 860_000_000_000_000_000n }),
    name: 'cbETH/USDC',
    loanToken: USDC, collateralToken: cbETH, oracle: ORACLE, irm: IRM, lltv: 860_000_000_000_000_000n,
  };

  it('keeps a market whose on-chain params round-trip', async () => {
    const multicall = vi.fn().mockResolvedValueOnce([ok([USDC, cbETH, ORACLE, IRM, 860_000_000_000_000_000n])]);
    const adapter = new MorphoBlueAdapter({ client: { multicall }, morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', markets: [MARKET] });
    await adapter._validateMarkets();
    expect(adapter.markets).toHaveLength(1);
  });

  it('drops a market whose oracle drifted from config', async () => {
    const multicall = vi.fn().mockResolvedValueOnce([ok([USDC, cbETH, IRM /* wrong oracle */, IRM, 860_000_000_000_000_000n])]);
    const adapter = new MorphoBlueAdapter({ client: { multicall }, morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', markets: [MARKET] });
    await adapter._validateMarkets();
    expect(adapter.markets).toHaveLength(0);
    expect(adapter.borrowers.size).toBe(0);
  });

  it('drops a market whose call reverts', async () => {
    const multicall = vi.fn().mockResolvedValueOnce([fail()]);
    const adapter = new MorphoBlueAdapter({ client: { multicall }, morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', markets: [MARKET] });
    await adapter._validateMarkets();
    expect(adapter.markets).toHaveLength(0);
  });
});
