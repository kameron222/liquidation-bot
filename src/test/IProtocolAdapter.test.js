import { describe, it, expect } from 'vitest';
import { IProtocolAdapter } from '../../adapters/IProtocolAdapter.js';

describe('IProtocolAdapter', () => {
  const a = new IProtocolAdapter();

  it('indexBorrowers rejects until overridden', async () => {
    await expect(a.indexBorrowers()).rejects.toThrow(/must be implemented/);
  });

  it('getLiquidatable rejects until overridden', async () => {
    await expect(a.getLiquidatable()).rejects.toThrow(/must be implemented/);
  });

  it('buildLiquidationCall throws until overridden', () => {
    expect(() => a.buildLiquidationCall({})).toThrow(/must be implemented/);
  });

  it('estimateProfit rejects until overridden', async () => {
    await expect(a.estimateProfit({})).rejects.toThrow(/must be implemented/);
  });
});
