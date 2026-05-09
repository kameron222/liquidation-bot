/**
 * Disk-backed cache for per-mToken metadata: `{ underlying, decimals, symbol }`.
 *
 * The Moonwell config file (`config/moonwell.js`) only carries `symbol` and
 * the mToken address. The actual underlying ERC20 address and its decimals
 * live on-chain. Calling `underlying()` and `decimals()` for ~21 markets on
 * every startup is wasteful, so the adapter populates this cache on first
 * boot and reads it thereafter.
 *
 * Format (JSON):
 *   {
 *     "0xMtoken1": { "underlying": "0x...", "decimals": 18, "symbol": "mWETH" },
 *     ...
 *   }
 *
 * On parse failure → treated as "no cache", caller refetches. Writes are
 * atomic via tmp+rename, same pattern as BorrowerCache.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import logger from '../utils/logger.js';

export class TokenMetadataCache {
  /** @param {{ path: string }} cfg */
  constructor(cfg) {
    if (!cfg?.path) throw new Error('TokenMetadataCache: path required');
    this.path = cfg.path;
  }

  /**
   * @returns {Promise<Map<string, { underlying: string, decimals: number, symbol: string }>>}
   *   Empty map when the file is missing or unparseable. Keys are lowercase
   *   mToken addresses.
   */
  async load() {
    let raw;
    try {
      raw = await fs.readFile(this.path, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return new Map();
      logger.warn('tokenMetadataCache.load read failed', { path: this.path, error: err.message });
      return new Map();
    }
    try {
      const parsed = JSON.parse(raw);
      const map = new Map();
      for (const [mToken, meta] of Object.entries(parsed)) {
        if (!meta?.underlying || typeof meta.decimals !== 'number') continue;
        map.set(mToken.toLowerCase(), {
          underlying: meta.underlying,
          decimals: meta.decimals,
          symbol: meta.symbol ?? '',
        });
      }
      return map;
    } catch (err) {
      logger.warn('tokenMetadataCache.load parse failed — refetching', { path: this.path, error: err.message });
      return new Map();
    }
  }

  /** @param {Map<string, { underlying: string, decimals: number, symbol: string }>} map */
  async save(map) {
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    const obj = {};
    for (const [mToken, meta] of map.entries()) obj[mToken] = meta;
    const tmp = `${this.path}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(obj));
    await fs.rename(tmp, this.path);
  }
}
