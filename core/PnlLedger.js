/**
 * PnlLedger — append-only JSONL ledger of liquidation attempts.
 *
 * One record per `executor.run` (or batched submission) call:
 *   { ts, borrower, estProfitUsd, estGasUsd, estNetUsd, txHash, status,
 *     actualGasUsd?, actualNetUsd? }
 *
 * `status` is the final outcome:
 *   - 'success'         — tx mined, status=success
 *   - 'reverted'        — tx mined, status=reverted (we lost the race)
 *   - 'skipped-stale'   — StaleCandidateError (estimateGas reverted; no tx)
 *   - 'gas-over-cap'    — GasOverCapError (no tx)
 *   - 'send-error'      — sendTransaction itself threw (no receipt)
 *   - 'dry-run'         — DRY_RUN=true; no tx
 *
 * `actualGasUsd` and `actualNetUsd` are computed by the caller using
 * `gasUsed * effectiveGasPrice` plus the cached WETH price; we don't decode
 * Transfer events (yet) so realised swap PnL isn't computed here.
 *
 * `summarise(sinceMs)` reads the ledger and returns counts + sums for the
 * requested window. Used by `npm run pnl` and the Discord boot embed.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const PNL_STATUS = Object.freeze({
  SUCCESS:       'success',
  REVERTED:      'reverted',
  SKIPPED_STALE: 'skipped-stale',
  GAS_OVER_CAP:  'gas-over-cap',
  SEND_ERROR:    'send-error',
  DRY_RUN:       'dry-run',
});

export class PnlLedger {
  /**
   * @param {{ path: string }} cfg
   */
  constructor(cfg) {
    if (!cfg?.path) throw new Error('PnlLedger: path required');
    this.path = cfg.path;
  }

  async append(record) {
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    const enriched = { ts: record.ts ?? new Date().toISOString(), ...record };
    await fs.appendFile(this.path, JSON.stringify(enriched) + '\n');
    return enriched;
  }

  /**
   * Read the ledger and aggregate records from `sinceMs` onward.
   *
   * @param {number} sinceMs Unix ms boundary (records older than this are dropped). Defaults to 0.
   */
  async summarise(sinceMs = 0) {
    let raw;
    try {
      raw = await fs.readFile(this.path, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return emptySummary();
      throw err;
    }
    const lines = raw.split('\n').filter((l) => l.length > 0);
    const summary = emptySummary();
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const t = Date.parse(rec.ts ?? '');
      if (Number.isFinite(t) && t < sinceMs) continue;
      summary.total += 1;
      summary.byStatus[rec.status] = (summary.byStatus[rec.status] ?? 0) + 1;
      if (typeof rec.estNetUsd === 'number')   summary.estNetUsd   += rec.estNetUsd;
      if (typeof rec.actualNetUsd === 'number') summary.actualNetUsd += rec.actualNetUsd;
      if (typeof rec.actualGasUsd === 'number') summary.actualGasUsd += rec.actualGasUsd;
    }
    return summary;
  }
}

function emptySummary() {
  return {
    total: 0,
    byStatus: {},
    estNetUsd: 0,
    actualNetUsd: 0,
    actualGasUsd: 0,
  };
}
