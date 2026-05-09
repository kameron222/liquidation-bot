/**
 * Disk-backed borrower cache. Lets `MoonwellAdapter.indexBorrowers()` skip
 * the multi-million-block bootstrap on every restart by remembering the
 * borrower set and the last-scanned block on disk.
 *
 * Format:
 *   { borrowers: ["0x...", ...], lastScannedBlock: "12345678" }
 *
 * `lastScannedBlock` is a decimal string because JSON has no `bigint`. Reads
 * convert back to `bigint`.
 *
 * Writes are atomic (write tmp + rename) so a crash mid-write can never
 * corrupt the cache. A corrupt or missing file is treated as "no cache" —
 * the caller will rebootstrap from scratch — never as a fatal error.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import logger from '../utils/logger.js';

export class BorrowerCache {
  /** @param {{ path: string }} cfg */
  constructor(cfg) {
    if (!cfg?.path) throw new Error('BorrowerCache: path required');
    this.path = cfg.path;
  }

  /**
   * @returns {Promise<{ borrowers: Set<string>, lastScannedBlock: bigint }>}
   *   Empty set + 0n when the file is missing or unparseable.
   */
  async load() {
    let raw;
    try {
      raw = await fs.readFile(this.path, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return empty();
      logger.warn('borrowerCache.load read failed', { path: this.path, error: err.message });
      return empty();
    }

    try {
      const parsed = JSON.parse(raw);
      const borrowers = new Set(Array.isArray(parsed.borrowers) ? parsed.borrowers : []);
      const last = typeof parsed.lastScannedBlock === 'string' ? BigInt(parsed.lastScannedBlock) : 0n;
      return { borrowers, lastScannedBlock: last };
    } catch (err) {
      logger.warn('borrowerCache.load parse failed — rebootstrapping', { path: this.path, error: err.message });
      return empty();
    }
  }

  /**
   * @param {{ borrowers: Set<string>|Iterable<string>, lastScannedBlock: bigint }} state
   */
  async save(state) {
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    const payload = JSON.stringify({
      borrowers: [...state.borrowers],
      lastScannedBlock: state.lastScannedBlock.toString(),
    });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await fs.writeFile(tmp, payload);
    await fs.rename(tmp, this.path);
  }
}

function empty() {
  return { borrowers: new Set(), lastScannedBlock: 0n };
}
