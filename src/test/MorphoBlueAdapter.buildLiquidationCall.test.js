import { describe, it, expect, vi } from 'vitest';
import { decodeFunctionData } from 'viem';
import { MorphoBlueAdapter } from '../../adapters/MorphoBlueAdapter.js';

const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const USDC   = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const cbETH  = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22';
const LIQUIDATOR = '0x1234000000000000000000000000000000005678';
const BORROWER   = '0xbbbb000000000000000000000000000000000002';

const MARKET = {
  id: `0x${'11'.repeat(32)}`,
  name: 'cbETH/USDC (86%)',
  loanToken: USDC,
  collateralToken: cbETH,
  oracle: '0x4756c26E01E61c7c2F86b10f4316e179db8F9425',
  irm: '0x46415998764C29aB2a25CbeA6254146D50D22687',
  lltv: 860_000_000_000_000_000n,
};

const MARKET_PARAMS = {
  loanToken: MARKET.loanToken,
  collateralToken: MARKET.collateralToken,
  oracle: MARKET.oracle,
  irm: MARKET.irm,
  lltv: MARKET.lltv,
};

// Minimal ABI to decode what buildLiquidationCall encodes.
const ABI = [
  {
    type: 'function', name: 'liquidate', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'marketParams', type: 'tuple', components: [
        { name: 'loanToken', type: 'address' }, { name: 'collateralToken', type: 'address' },
        { name: 'oracle', type: 'address' }, { name: 'irm', type: 'address' }, { name: 'lltv', type: 'uint256' },
      ] },
      { name: 'borrower', type: 'address' },
      { name: 'seizedAssets', type: 'uint256' },
      { name: 'swapPath', type: 'bytes' },
      { name: 'amountOutMinimum', type: 'uint256' },
    ],
  },
  {
    type: 'function', name: 'liquidateAero', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'marketParams', type: 'tuple', components: [
        { name: 'loanToken', type: 'address' }, { name: 'collateralToken', type: 'address' },
        { name: 'oracle', type: 'address' }, { name: 'irm', type: 'address' }, { name: 'lltv', type: 'uint256' },
      ] },
      { name: 'borrower', type: 'address' },
      { name: 'seizedAssets', type: 'uint256' },
      { name: 'aeroRoutes', type: 'tuple[]', components: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
        { name: 'stable', type: 'bool' }, { name: 'factory', type: 'address' },
      ] },
      { name: 'amountOutMinimum', type: 'uint256' },
    ],
  },
];

function buildAdapter() {
  const adapter = new MorphoBlueAdapter({
    client: { multicall: vi.fn() },
    morpho: MORPHO,
    markets: [MARKET],
    liquidatorAddress: LIQUIDATOR,
  });
  adapter._marketsValidated = true;
  return adapter;
}

describe('MorphoBlueAdapter.buildLiquidationCall', () => {
  it('throws if estimateProfit has not stamped a plan', () => {
    const adapter = buildAdapter();
    expect(() => adapter.buildLiquidationCall({ borrower: BORROWER }))
      .toThrow(/call estimateProfit/);
  });

  it('throws when no liquidator address is configured', () => {
    const adapter = buildAdapter();
    adapter.liquidatorAddress = null;
    const pos = { borrower: BORROWER, _plan: { venue: 'V3', swapPath: '0x00', seizedAssets: 1n, marketParams: MARKET_PARAMS, amountOutMinimum: 1n } };
    expect(() => adapter.buildLiquidationCall(pos)).toThrow(/liquidatorAddress required/);
  });

  it('encodes a V3 liquidate() call', () => {
    const adapter = buildAdapter();
    const pos = {
      borrower: BORROWER,
      _plan: {
        marketParams: MARKET_PARAMS,
        borrower: BORROWER,
        seizedAssets: 904_600_000_000_000_000n,
        venue: 'V3',
        swapPath: '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22000064833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        amountOutMinimum: 2_686_500_000n,
      },
    };
    const call = adapter.buildLiquidationCall(pos);
    expect(call.to).toBe(LIQUIDATOR);
    expect(call.value).toBe(0n);

    const decoded = decodeFunctionData({ abi: ABI, data: call.data });
    expect(decoded.functionName).toBe('liquidate');
    expect(decoded.args[0]).toMatchObject({ loanToken: USDC, collateralToken: cbETH, lltv: MARKET.lltv });
    expect(decoded.args[1].toLowerCase()).toBe(BORROWER);
    expect(decoded.args[2]).toBe(904_600_000_000_000_000n);
    expect(decoded.args[4]).toBe(2_686_500_000n);
  });

  it('encodes an Aerodrome liquidateAero() call', () => {
    const adapter = buildAdapter();
    const routes = [
      { from: cbETH, to: '0x4200000000000000000000000000000000000006', stable: false, factory: '0x0000000000000000000000000000000000000000' },
    ];
    const pos = {
      borrower: BORROWER,
      _plan: {
        marketParams: MARKET_PARAMS,
        borrower: BORROWER,
        seizedAssets: 1_000n,
        venue: 'AERO',
        aeroRoutes: routes,
        amountOutMinimum: 900n,
      },
    };
    const call = adapter.buildLiquidationCall(pos);
    const decoded = decodeFunctionData({ abi: ABI, data: call.data });
    expect(decoded.functionName).toBe('liquidateAero');
    expect(decoded.args[3][0]).toMatchObject({ from: cbETH, stable: false });
  });

  it('throws on a V3 plan missing its swapPath', () => {
    const adapter = buildAdapter();
    const pos = { borrower: BORROWER, _plan: { venue: 'V3', swapPath: null, marketParams: MARKET_PARAMS, seizedAssets: 1n } };
    expect(() => adapter.buildLiquidationCall(pos)).toThrow(/V3 venue without swapPath/);
  });
});
