/**
 * Executor — turns a `{to, data, value}` returned by an adapter into a signed,
 * mined transaction. Pre-flights `maxFeePerGas` against `MAX_GAS_PRICE_GWEI`
 * and surfaces a typed error so the monitor can post a "skipped" Discord
 * embed cleanly.
 *
 * Fee model (EIP-1559):
 *   maxPriorityFeePerGas := PRIORITY_FEE_GWEI (default 1 gwei — well above
 *     Base's ~0.001 gwei median priority and a clear "include me next block"
 *     signal to sequencers).
 *   maxFeePerGas := 2 * baseFee + maxPriorityFeePerGas
 *   The cap (`maxGasGwei`) applies to maxFeePerGas. When 2*baseFee+priority
 *   exceeds the cap, we throw GasOverCapError without sending.
 *
 * Gas estimation strategy:
 *   `publicClient.estimateGas` is required to succeed. A revert here means
 *   the position state changed between candidate detection and simulation
 *   (oracle moved, competitor liquidated us, etc.) — we throw
 *   `StaleCandidateError` so the monitor surfaces a warn embed and skips,
 *   rather than burning ~$2 to revert on-chain with a fallback budget.
 *
 * Parallel submission (`runMany`):
 *   When the same tick produces multiple profitable candidates we want to
 *   send them in parallel from the same nonce window so the second isn't
 *   waiting on the first's receipt. `runMany` reads pending nonce once,
 *   estimates each call concurrently, and submits the surviving ones with
 *   explicit incrementing nonces. Per-candidate failures (StaleCandidateError,
 *   send errors) are returned in-band rather than thrown so a single bad
 *   candidate doesn't poison the batch.
 *
 * Dry-run mode (`dryRun: true`): log the would-be transaction and return a
 * synthetic success receipt without sending. Used to validate the full
 * pipeline against live state before risking ETH.
 */

import logger from '../utils/logger.js';

const GWEI = 1_000_000_000n;
const GAS_BUFFER_NUM = 12n;
const GAS_BUFFER_DEN = 10n;
const DEFAULT_PRIORITY_FEE_GWEI = 1n;
const DRY_RUN_TX_HASH = '0x0000000000000000000000000000000000000000000000000000000000000dead';

export class GasOverCapError extends Error {
  constructor({ gasPriceWei, capWei }) {
    const gwei = Number(gasPriceWei / 1_000_000n) / 1000;
    const capGwei = Number(capWei / 1_000_000n) / 1000;
    super(`gas price ${gwei} gwei exceeds cap ${capGwei} gwei`);
    this.name = 'GasOverCapError';
    this.gasPriceWei = gasPriceWei;
    this.capWei = capWei;
  }
}

export class StaleCandidateError extends Error {
  constructor({ to, reason }) {
    super(`estimateGas reverted (stale candidate): ${reason}`);
    this.name = 'StaleCandidateError';
    this.to = to;
    this.reason = reason;
  }
}

export class Executor {
  /**
   * @param {{
   *   walletClient: import('viem').WalletClient,
   *   publicClient: import('viem').PublicClient,
   *   maxGasGwei: number,
   *   priorityFeeGwei?: number,
   *   dryRun?: boolean,
   * }} cfg
   */
  constructor(cfg) {
    if (!cfg?.walletClient) throw new Error('Executor: walletClient required');
    if (!cfg?.publicClient) throw new Error('Executor: publicClient required');
    this.walletClient = cfg.walletClient;
    this.publicClient = cfg.publicClient;
    this.maxGasWei = BigInt(Math.round(cfg.maxGasGwei)) * GWEI;
    this.priorityFeeBaseWei = cfg.priorityFeeGwei != null
      ? BigInt(Math.round(cfg.priorityFeeGwei * 1000)) * 1_000_000n // gwei → wei via mgwei to keep sub-gwei precision
      : DEFAULT_PRIORITY_FEE_GWEI * GWEI;
    this.dryRun = !!cfg.dryRun;

    // Adaptive priority fee: bumps 50% on consecutive on-chain reverts (lost
    // races), decays toward base on each success. Cap at maxGas/4 — even
    // under contention we'd rather skip than overpay.
    this.priorityFeeWei = this.priorityFeeBaseWei;
    this._priorityFeeCap = this.maxGasWei / 4n;
    this._consecutiveReverts = 0;
  }

  /**
   * Execute one call. Returns the receipt summary on success;
   * throws `GasOverCapError` or `StaleCandidateError` (no tx sent) on
   * pre-flight failure, or any other error on send/receipt failure.
   *
   * @param {{ to: `0x${string}`, data: `0x${string}`, value?: bigint }} call
   * @returns {Promise<{ txHash: `0x${string}`, status: 'success'|'reverted', gasUsed: bigint, effectiveGasPrice: bigint }>}
   */
  async run(call) {
    const fees = await this._currentFees();
    const gas = await this._estimateOrThrow(call);

    if (this.dryRun) {
      this._logDryRun(call, gas, fees);
      return { txHash: DRY_RUN_TX_HASH, status: 'success', gasUsed: gas, effectiveGasPrice: fees.maxFeePerGas, dryRun: true };
    }

    const txHash = await this.walletClient.sendTransaction({
      to: call.to,
      data: call.data,
      value: call.value ?? 0n,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    this._recordOutcome(receipt.status);
    return {
      txHash,
      status: receipt.status,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice ?? fees.maxFeePerGas,
    };
  }

  /**
   * Submit N calls in parallel from the same nonce window. Pre-flights gas
   * cap once for the whole batch (throws GasOverCapError if over). Each call
   * is estimated and sent concurrently; per-call failures are returned
   * in-band as `{ error }` entries so a stale candidate doesn't poison the batch.
   *
   * Output array is index-aligned with `calls`. Each entry is one of:
   *   - `{ txHash, status, gasUsed, effectiveGasPrice, nonce }` (sent)
   *   - `{ error: StaleCandidateError | Error, nonce? }` (skipped or send-failed)
   *
   * @param {Array<{ to: `0x${string}`, data: `0x${string}`, value?: bigint }>} calls
   */
  async runMany(calls) {
    if (!Array.isArray(calls)) throw new Error('Executor.runMany: calls array required');
    if (calls.length === 0) return [];
    if (calls.length === 1) {
      try {
        const r = await this.run(calls[0]);
        return [r];
      } catch (err) {
        return [{ error: err }];
      }
    }

    const fees = await this._currentFees();

    // Estimate each call concurrently. Failures are recorded as in-band
    // StaleCandidateError so we still send the survivors.
    const estimates = await Promise.all(calls.map(async (call) => {
      try {
        return { ok: true, gas: await this._estimateOrThrow(call) };
      } catch (err) {
        return { ok: false, error: err };
      }
    }));

    if (this.dryRun) {
      return estimates.map((e, i) => {
        if (!e.ok) return { error: e.error };
        this._logDryRun(calls[i], e.gas, fees);
        return { txHash: DRY_RUN_TX_HASH, status: 'success', gasUsed: e.gas, effectiveGasPrice: fees.maxFeePerGas, dryRun: true };
      });
    }

    // One pending-nonce read for the whole batch; we hand out incrementing
    // nonces only to the survivors.
    const baseNonce = await this.publicClient.getTransactionCount({
      address: this.walletClient.account.address,
      blockTag: 'pending',
    });

    let nonceOffset = 0;
    const sends = estimates.map((e, i) => {
      if (!e.ok) return { idx: i, ok: false, error: e.error };
      const nonce = baseNonce + nonceOffset++;
      const sendPromise = (async () => {
        try {
          const txHash = await this.walletClient.sendTransaction({
            to: calls[i].to,
            data: calls[i].data,
            value: calls[i].value ?? 0n,
            gas: e.gas,
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            nonce,
          });
          const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
          this._recordOutcome(receipt.status);
          return {
            txHash,
            status: receipt.status,
            gasUsed: receipt.gasUsed,
            effectiveGasPrice: receipt.effectiveGasPrice ?? fees.maxFeePerGas,
            nonce,
          };
        } catch (err) {
          return { error: err, nonce };
        }
      })();
      return { idx: i, ok: true, sendPromise };
    });

    const results = new Array(calls.length);
    await Promise.all(sends.map(async (s) => {
      if (!s.ok) { results[s.idx] = { error: s.error }; return; }
      results[s.idx] = await s.sendPromise;
    }));
    return results;
  }

  async _currentFees() {
    const block = await this.publicClient.getBlock({ blockTag: 'latest' });
    const baseFee = block?.baseFeePerGas ?? 0n;
    const maxPriorityFeePerGas = this.priorityFeeWei;
    const maxFeePerGas = 2n * baseFee + maxPriorityFeePerGas;
    if (maxFeePerGas > this.maxGasWei) {
      throw new GasOverCapError({ gasPriceWei: maxFeePerGas, capWei: this.maxGasWei });
    }
    return { baseFee, maxPriorityFeePerGas, maxFeePerGas };
  }

  async _estimateOrThrow(call) {
    try {
      const estimate = await this.publicClient.estimateGas({
        account: this.walletClient.account.address,
        to: call.to,
        data: call.data,
        value: call.value ?? 0n,
      });
      return (estimate * GAS_BUFFER_NUM) / GAS_BUFFER_DEN;
    } catch (err) {
      throw new StaleCandidateError({
        to: call.to,
        reason: err?.shortMessage ?? err?.message ?? String(err),
      });
    }
  }

  _recordOutcome(status) {
    const before = this.priorityFeeWei;
    if (status === 'success') {
      this._consecutiveReverts = 0;
      // Decay 30% toward base, floor at base.
      const decayed = (this.priorityFeeWei * 7n) / 10n;
      this.priorityFeeWei = decayed < this.priorityFeeBaseWei ? this.priorityFeeBaseWei : decayed;
    } else if (status === 'reverted') {
      this._consecutiveReverts += 1;
      if (this._consecutiveReverts >= 2) {
        const bumped = (this.priorityFeeWei * 15n) / 10n;
        this.priorityFeeWei = bumped > this._priorityFeeCap ? this._priorityFeeCap : bumped;
      }
    }
    if (this.priorityFeeWei !== before) {
      logger.info('executor.priorityFee adjusted', {
        status,
        consecutiveReverts: this._consecutiveReverts,
        priorityFeeGwei: (Number(this.priorityFeeWei) / 1e9).toFixed(4),
        priorityFeeBaseGwei: (Number(this.priorityFeeBaseWei) / 1e9).toFixed(4),
        capGwei: (Number(this._priorityFeeCap) / 1e9).toFixed(4),
      });
    }
  }

  _logDryRun(call, gas, fees) {
    logger.info('executor.dryRun (would send)', {
      to: call.to,
      data: call.data,
      value: (call.value ?? 0n).toString(),
      gas: gas.toString(),
      maxFeePerGasGwei: (Number(fees.maxFeePerGas) / 1e9).toFixed(4),
      maxPriorityFeePerGasGwei: (Number(fees.maxPriorityFeePerGas) / 1e9).toFixed(4),
      baseFeeGwei: (Number(fees.baseFee) / 1e9).toFixed(4),
    });
  }
}
