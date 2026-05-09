import { describe, it, expect } from 'vitest';
import { pickSwapPath, pathFeeBps, TOKENS_BASE } from '../../config/uniswap.js';

describe('pickSwapPath', () => {
  it("returns '0x' for same-token", () => {
    expect(pickSwapPath(TOKENS_BASE.WETH, TOKENS_BASE.WETH)).toBe('0x');
    expect(pickSwapPath(TOKENS_BASE.USDC, TOKENS_BASE.USDC.toLowerCase())).toBe('0x');
  });

  it('returns single-hop packed path for a known direct pair', () => {
    const path = pickSwapPath(TOKENS_BASE.WETH, TOKENS_BASE.USDC);
    // address(20) || uint24(3) || address(20) = 43 bytes = 86 hex + '0x'.
    expect(path).toHaveLength(2 + 86);
    expect(path.startsWith('0x' + TOKENS_BASE.WETH.slice(2).toLowerCase())).toBe(true);
    // 500 → 0x0001f4
    expect(path.slice(2 + 40, 2 + 40 + 6)).toBe('0001f4');
    expect(path.endsWith(TOKENS_BASE.USDC.slice(2).toLowerCase())).toBe(true);
  });

  it('routes a long-tail pair through WETH as a two-hop path', () => {
    // AERO ↔ USDC isn't in the table, but AERO↔WETH (3000) and WETH↔USDC (500) are.
    const path = pickSwapPath(TOKENS_BASE.AERO, TOKENS_BASE.USDC);
    // 20 + 3 + 20 + 3 + 20 = 66 bytes = 132 hex + '0x'.
    expect(path).toHaveLength(2 + 132);
    expect(path.startsWith('0x' + TOKENS_BASE.AERO.slice(2).toLowerCase())).toBe(true);
    expect(path.endsWith(TOKENS_BASE.USDC.slice(2).toLowerCase())).toBe(true);
    // First hop AERO→WETH at fee 3000 = 0x000bb8
    expect(path.slice(2 + 40, 2 + 40 + 6)).toBe('000bb8');
    // Second hop WETH→USDC at fee 500 = 0x0001f4
    expect(path.slice(2 + 40 + 6 + 40, 2 + 40 + 6 + 40 + 6)).toBe('0001f4');
  });

  it('returns null when neither a direct nor WETH-bridged path exists', () => {
    // Two random non-canonical addresses with no entries in the fee table.
    const a = '0x000000000000000000000000000000000000aaaa';
    const b = '0x000000000000000000000000000000000000bbbb';
    expect(pickSwapPath(a, b)).toBeNull();
  });

  it('does not bridge through WETH when one leg is already WETH', () => {
    // If WETH↔X isn't in the table, we'd never re-route through WETH.
    const x = '0x000000000000000000000000000000000000aaaa';
    expect(pickSwapPath(TOKENS_BASE.WETH, x)).toBeNull();
    expect(pickSwapPath(x, TOKENS_BASE.WETH)).toBeNull();
  });

  it('throws on a malformed address', () => {
    expect(() => pickSwapPath('0xnope', TOKENS_BASE.USDC)).toThrow(/bad address/);
  });
});

describe('pathFeeBps', () => {
  it('returns 0 for same-token', () => {
    expect(pathFeeBps(TOKENS_BASE.USDC, TOKENS_BASE.USDC)).toBe(0n);
  });

  it('returns the single hop fee in bps for a direct pair', () => {
    // WETH↔USDC = 500 → 5 bps
    expect(pathFeeBps(TOKENS_BASE.WETH, TOKENS_BASE.USDC)).toBe(5n);
    // WETH↔cbBTC = 3000 → 30 bps
    expect(pathFeeBps(TOKENS_BASE.WETH, TOKENS_BASE.cbBTC)).toBe(30n);
  });

  it('sums fees along a 2-hop bridge through WETH', () => {
    // AERO↔WETH(3000) + WETH↔USDC(500) = 30 + 5 = 35 bps
    expect(pathFeeBps(TOKENS_BASE.AERO, TOKENS_BASE.USDC)).toBe(35n);
  });

  it('returns 0 when no path is buildable', () => {
    const a = '0x000000000000000000000000000000000000aaaa';
    const b = '0x000000000000000000000000000000000000bbbb';
    expect(pathFeeBps(a, b)).toBe(0n);
  });
});
