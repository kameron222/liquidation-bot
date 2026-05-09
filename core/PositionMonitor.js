/**
 * PositionMonitor — protocol-agnostic engine that drives one or more
 * IProtocolAdapter instances. The bot's "main loop".
 *
 * Lifecycle:
 *   start() → indexBorrowers() once per adapter → tick() in a loop.
 *   tick()  → for each adapter: getLiquidatable → estimateProfit →
 *             filter by minProfitUsd → notify → buildLiquidationCall → execute
 *             → notify result.
 *   stop()  → flips the run flag; the loop exits at the next iteration.
 *
 * Re-indexing: the borrower set drifts as new accounts borrow. We re-run
 * indexBorrowers every `reindexEvery` ticks (default 50; ~10 min at 12s polls).
 *
 * Failure isolation:
 *   - Per-position errors do NOT abort the tick. We notify and continue.
 *   - Adapter-level errors (e.g. RPC outage during getLiquidatable) DO abort
 *     the tick but not the loop — the next interval retries.
 *   - GasOverCapError surfaces as a `warn`-level Discord embed, no tx sent.
 */

import logger from '../utils/logger.js';
import { GasOverCapError, StaleCandidateError } from './Executor.js';
import { PNL_STATUS } from './PnlLedger.js';

const WAD = 10n ** 18n;

const DEFAULT_REINDEX_EVERY = 50;

export class PositionMonitor {
  /**
   * @param {{
   *   adapters: Array<import('../adapters/IProtocolAdapter.js').IProtocolAdapter>,
   *   executor: import('./Executor.js').Executor,
   *   notifier: import('../utils/notifier.js').Notifier,
   *   minProfitUsd: number,
   *   pollIntervalMs: number,
   *   reindexEvery?: number,
   *   wsClient?: import('viem').PublicClient,
   *   sleep?: (ms: number) => Promise<void>,
   *   ledger?: import('./PnlLedger.js').PnlLedger,
   * }} cfg
   */
  constructor(cfg) {
    if (!cfg?.adapters?.length) throw new Error('PositionMonitor: adapters required');
    if (!cfg.executor) throw new Error('PositionMonitor: executor required');
    if (!cfg.notifier) throw new Error('PositionMonitor: notifier required');
    this.adapters = cfg.adapters;
    this.executor = cfg.executor;
    this.notifier = cfg.notifier;
    this.minProfitUsd = cfg.minProfitUsd ?? 0;
    this.pollIntervalMs = cfg.pollIntervalMs ?? 12_000;
    this.reindexEvery = cfg.reindexEvery ?? DEFAULT_REINDEX_EVERY;
    this.evaluateConcurrency = Math.max(1, cfg.evaluateConcurrency ?? 4);
    this.wsClient = cfg.wsClient ?? null;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ledger = cfg.ledger ?? null;
    this._running = false;
    this._tickCount = 0;
    this._tickInFlight = false;
    this._unwatch = null;
  }

  async start() {
    if (this._running) return;
    this._running = true;
    this._tickCount = 0;

    const mode = this.wsClient ? 'block' : 'poll';
    logger.info('monitor.start', {
      adapters: this.adapters.length,
      minProfitUsd: this.minProfitUsd,
      pollIntervalMs: this.pollIntervalMs,
      mode,
    });
    await this.notifier.send({
      level: 'info',
      title: 'Liquidation bot online',
      fields: [
        { name: 'adapters', value: String(this.adapters.length), inline: true },
        { name: 'minProfit', value: `$${this.minProfitUsd}`, inline: true },
        { name: 'mode',     value: mode, inline: true },
      ],
    });

    await this._postBootRollup();

    for (const adapter of this.adapters) {
      await this._safeIndex(adapter);
    }

    if (mode === 'block') {
      await this._runBlockLoop();
    } else {
      await this._runPollLoop();
    }
  }

  async stop() {
    this._running = false;
    if (this._unwatch) {
      try { this._unwatch(); } catch { /* ignore */ }
      this._unwatch = null;
    }
  }

  async _runPollLoop() {
    while (this._running) {
      await this._guardedTick();
      this._tickCount++;
      if (!this._running) break;
      await this.sleep(this.pollIntervalMs);
    }
  }

  // Block-driven loop: subscribe to new heads, fire tick() on each. Skips a
  // block if the previous tick is still running (don't pile up). Falls back
  // to a poll loop if the subscription dies and isn't recovered.
  async _runBlockLoop() {
    await new Promise((resolve) => {
      this._unwatch = this.wsClient.watchBlockNumber({
        emitOnBegin: true,
        onBlockNumber: (blockNumber) => {
          if (!this._running) { resolve(); return; }
          if (this._tickInFlight) {
            logger.debug('monitor.skipTick (in flight)', { blockNumber: blockNumber?.toString?.() });
            return;
          }
          // Fire-and-forget; errors handled inside _guardedTick.
          this._tickInFlight = true;
          this._guardedTick()
            .finally(() => {
              this._tickInFlight = false;
              this._tickCount++;
              if (!this._running) resolve();
            });
        },
        onError: (err) => {
          logger.warn('monitor.watchBlockNumber error', { error: err?.message ?? String(err) });
        },
      });
    });
  }

  async _guardedTick() {
    try {
      await this.tick();
    } catch (err) {
      logger.error('monitor.tick uncaught', { error: err?.message ?? String(err) });
      await this.notifier.send({
        level: 'error',
        title: 'Monitor tick crashed',
        description: err?.message ?? String(err),
      });
    }
  }

  /**
   * Run a single monitoring cycle. Exposed so tests can invoke deterministically
   * without spawning the loop.
   */
  async tick() {
    if (this._tickCount > 0 && this._tickCount % this.reindexEvery === 0) {
      for (const adapter of this.adapters) {
        await this._safeIndex(adapter);
      }
    }

    for (const adapter of this.adapters) {
      let positions;
      try {
        positions = await adapter.getLiquidatable();
      } catch (err) {
        logger.error('monitor.getLiquidatable failed', { error: err?.message ?? String(err) });
        continue;
      }
      logger.debug('monitor.tick', { liquidatable: positions.length });

      // Bounded-concurrency evaluation: each estimateProfit fires an
      // eth_gasPrice + a fat aggregate3 multicall, so unbounded Promise.all
      // blows free-tier RPC CUPS. Per-candidate errors are isolated inside
      // _evaluatePosition (returns null on failure).
      const evaluations = await mapWithConcurrency(
        positions,
        this.evaluateConcurrency,
        (p) => this._evaluatePosition(adapter, p),
      );
      const profitable = evaluations.filter((e) => e !== null);

      if (profitable.length > 0) {
        // Notify candidates first so the user sees them even if executor.runMany throws.
        for (const e of profitable) await this._notifyCandidate(e);
        const receipts = await this._safeRunMany(profitable.map((e) => e.call));
        for (let i = 0; i < profitable.length; i++) {
          await this._handleReceipt(profitable[i], receipts[i]);
        }
      }

      await this._reportSilentSkips(adapter);
    }
  }

  // Wrap executor.runMany so a batch-level GasOverCapError surfaces as
  // per-position warns rather than crashing the tick. Per-candidate failures
  // are already in-band on the result array.
  async _safeRunMany(calls) {
    try {
      return await this.executor.runMany(calls);
    } catch (err) {
      // Most likely GasOverCapError — applies to the whole batch.
      return calls.map(() => ({ error: err }));
    }
  }

  async _notifyCandidate({ position, estimate }) {
    await this.notifier.send({
      level: 'info',
      title: `Candidate: $${estimate.netUsd.toFixed(2)} net`,
      fields: [
        { name: 'borrower', value: position.borrower, inline: false },
        { name: 'profit',   value: `$${estimate.profitUsd.toFixed(2)}`, inline: true },
        { name: 'gas',      value: `$${estimate.gasCostUsd.toFixed(2)}`, inline: true },
        { name: 'net',      value: `$${estimate.netUsd.toFixed(2)}`, inline: true },
      ],
    });
  }

  async _handleReceipt({ position, estimate }, receipt) {
    if (receipt?.error) {
      const err = receipt.error;
      if (err instanceof GasOverCapError) {
        await this._recordPnl(position, estimate, { status: PNL_STATUS.GAS_OVER_CAP });
        await this.notifier.send({
          level: 'warn',
          title: 'Skipped: gas over cap',
          fields: [
            { name: 'borrower', value: position.borrower, inline: false },
            { name: 'profit',   value: `$${estimate.netUsd.toFixed(2)}`, inline: true },
            { name: 'reason',   value: err.message, inline: false },
          ],
        });
        return;
      }
      if (err instanceof StaleCandidateError) {
        await this._recordPnl(position, estimate, { status: PNL_STATUS.SKIPPED_STALE });
        logger.warn('monitor.staleCandidate', { borrower: position.borrower, reason: err.reason });
        await this.notifier.send({
          level: 'warn',
          title: 'Skipped: stale candidate (estimateGas reverted)',
          fields: [
            { name: 'borrower', value: position.borrower, inline: false },
            { name: 'profit',   value: `$${estimate.netUsd.toFixed(2)}`, inline: true },
            { name: 'reason',   value: err.reason, inline: false },
          ],
        });
        return;
      }
      await this._recordPnl(position, estimate, { status: PNL_STATUS.SEND_ERROR });
      await this.notifier.send({
        level: 'error',
        title: 'Liquidation send failed',
        description: err?.message ?? String(err),
        fields: [{ name: 'borrower', value: position.borrower, inline: false }],
      });
      return;
    }

    const actualGasUsd = computeActualGasUsd(receipt, estimate);
    if (receipt.status === 'success') {
      await this._recordPnl(position, estimate, {
        status: receipt.dryRun ? PNL_STATUS.DRY_RUN : PNL_STATUS.SUCCESS,
        txHash: receipt.txHash,
        actualGasUsd,
        actualNetUsd: estimate.profitUsd - (estimate.tradeCostsUsd ?? 0) - actualGasUsd,
      });
      await this.notifier.send({
        level: 'success',
        title: `Liquidated $${estimate.netUsd.toFixed(2)}`,
        fields: [
          { name: 'tx',     value: `https://basescan.org/tx/${receipt.txHash}`, inline: false },
          { name: 'gasUsed', value: String(receipt.gasUsed), inline: true },
          { name: 'borrower', value: position.borrower, inline: true },
        ],
      });
    } else {
      await this._recordPnl(position, estimate, {
        status: PNL_STATUS.REVERTED,
        txHash: receipt.txHash,
        actualGasUsd,
        actualNetUsd: -actualGasUsd,
      });
      await this.notifier.send({
        level: 'error',
        title: 'Liquidation reverted on-chain',
        fields: [
          { name: 'tx',       value: `https://basescan.org/tx/${receipt.txHash}`, inline: false },
          { name: 'borrower', value: position.borrower, inline: false },
        ],
      });
    }
  }

  async _evaluatePosition(adapter, position) {
    let estimate;
    try {
      estimate = await adapter.estimateProfit(position);
    } catch (err) {
      logger.warn('monitor.estimateProfit failed', { borrower: position.borrower, error: err?.message });
      return null;
    }
    if (estimate.netUsd < this.minProfitUsd) {
      logger.debug('monitor.position below minProfit', {
        borrower: position.borrower, netUsd: estimate.netUsd,
      });
      return null;
    }
    let call;
    try {
      call = adapter.buildLiquidationCall(position);
    } catch (err) {
      await this.notifier.send({
        level: 'error',
        title: 'buildLiquidationCall failed',
        description: err?.message ?? String(err),
        fields: [{ name: 'borrower', value: position.borrower, inline: false }],
      });
      return null;
    }
    return { position, estimate, call };
  }

  // Surface aggregate per-tick skip reasons (no swap path, balance fetch
  // failures, missing oracle/meta) so we notice when profitable candidates
  // are being silently dropped.
  async _reportSilentSkips(adapter) {
    if (typeof adapter.drainSilentSkips !== 'function') return;
    const skips = adapter.drainSilentSkips();
    if (!skips.length) return;
    const counts = new Map();
    for (const s of skips) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
    const fields = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, n]) => ({ name: reason, value: String(n), inline: true }));
    await this.notifier.send({
      level: 'warn',
      title: `Silent skips: ${skips.length} candidate pair(s) dropped`,
      description: 'Pairs that bypassed estimateProfit without a candidate. Most common reasons:',
      fields,
    });
  }

  async _safeIndex(adapter) {
    try {
      await adapter.indexBorrowers();
    } catch (err) {
      logger.error('monitor.indexBorrowers failed', { error: err?.message ?? String(err) });
      await this.notifier.send({
        level: 'error',
        title: 'Index borrowers failed',
        description: err?.message ?? String(err),
      });
    }
  }

  // Post a one-shot 24h ledger roll-up to Discord on boot. Quiet (no embed)
  // when there's no ledger or no records.
  async _postBootRollup() {
    if (!this.ledger) return;
    let summary;
    try {
      summary = await this.ledger.summarise(Date.now() - 24 * 3600 * 1000);
    } catch (err) {
      logger.warn('monitor.pnl.summarise failed', { error: err?.message ?? String(err) });
      return;
    }
    if (summary.total === 0) return;
    const fields = [
      { name: 'attempts',    value: String(summary.total), inline: true },
      { name: 'est net',     value: `$${summary.estNetUsd.toFixed(2)}`, inline: true },
      { name: 'actual net',  value: `$${summary.actualNetUsd.toFixed(2)}`, inline: true },
      ...Object.entries(summary.byStatus)
        .map(([s, n]) => ({ name: s, value: String(n), inline: true })),
    ];
    await this.notifier.send({ level: 'info', title: 'PnL — last 24h', fields });
  }

  async _recordPnl(position, estimate, extra) {
    if (!this.ledger) return;
    try {
      await this.ledger.append({
        borrower: position.borrower,
        estProfitUsd: estimate.profitUsd,
        estGasUsd: estimate.gasCostUsd,
        estNetUsd: estimate.netUsd,
        ...extra,
      });
    } catch (err) {
      logger.warn('monitor.pnl.append failed', { error: err?.message ?? String(err) });
    }
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

// Convert receipt's actual gas spend to USD using the cached ETH price the
// adapter stamped on the estimate. Falls back to the estimated gas USD when
// the price isn't available (e.g. dry-run or non-Moonwell adapter).
function computeActualGasUsd(receipt, estimate) {
  if (receipt?.dryRun) return estimate.gasCostUsd;
  const gasUsed = receipt?.gasUsed;
  const gasPrice = receipt?.effectiveGasPrice;
  const ethUsd1e18 = estimate?.ethUsd1e18;
  if (typeof gasUsed !== 'bigint' || typeof gasPrice !== 'bigint' || !ethUsd1e18) {
    return estimate.gasCostUsd;
  }
  const usd1e18 = (gasUsed * gasPrice * ethUsd1e18) / WAD;
  return Number(usd1e18) / 1e18;
}
