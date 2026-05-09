/**
 * MorphoBlueAdapter — IProtocolAdapter implementation for Morpho Blue on Base.
 *
 * Morpho Blue differs from Compound/Moonwell in three ways that shape this
 * adapter:
 *
 *   1. **Isolated markets, no Comptroller.** Each market is an independent
 *      (loanToken, collateralToken, oracle, irm, lltv) tuple keyed by
 *      `Id = keccak256(abi.encode(params))`. There is no global account
 *      liquidity call; health is computed per (market, borrower) off-chain.
 *
 *   2. **Balances are shares, not assets.** `position(id, user)` returns
 *      `borrowShares`; the debt in loan-token terms is
 *      `borrowShares.toAssetsUp(totalBorrowAssets, totalBorrowShares)` — with
 *      interest accrued forward from the market's `lastUpdate` via the IRM so
 *      we don't under-count a stale position.
 *
 *   3. **Free flash-loan via the liquidate callback.** Morpho hands the seized
 *      collateral to the liquidator inside `onMorphoLiquidate` *before* pulling
 *      the repaid loan tokens, so no Aave premium is paid — the swap output
 *      just has to cover the repay. Profit is simulated against live Uniswap V3
 *      reserves with QuoterV2 rather than a static haircut.
 *
 * Stage 1: indexBorrowers() — validate configured markets against the live
 *          singleton, then scan `Borrow` events (filtered per market id) for
 *          `onBehalf` borrower addresses.
 * Stage 2: getLiquidatable() — per market: read totals + oracle price, accrue
 *          interest, then multicall `position` over cached borrowers and keep
 *          those whose accrued debt exceeds their LLTV-scaled collateral value.
 * Stage 3: estimateProfit() — liquidation-incentive math, live V3 quote for the
 *          collateral→loan swap, USD via stablecoin pin / Chainlink ETH.
 * Stage 4: buildLiquidationCall() — encode MorphoLiquidator.{liquidate,
 *          liquidateAero}.
 *
 * Tests inject `client` directly to avoid hitting the network.
 */

import { createPublicClient, http, encodeFunctionData } from 'viem';
import { base } from 'viem/chains';
import { IProtocolAdapter } from './IProtocolAdapter.js';
import {
  MORPHO_ABI,
  MORPHO_BORROW_EVENT,
  MORPHO_ORACLE_ABI,
  MORPHO_IRM_ABI,
  MARKET_PARAMS_TUPLE,
} from '../config/abis/Morpho.js';
import { QUOTER_V2_ABI } from '../config/abis/Quoter.js';
import { CHAINLINK_AGGREGATOR_ABI } from '../config/abis/Chainlink.js';
import {
  ORACLE_PRICE_SCALE,
  VIRTUAL_SHARES,
  VIRTUAL_ASSETS,
  LIQUIDATION_CURSOR,
  MAX_LIQUIDATION_INCENTIVE_FACTOR,
  LOAN_TOKEN_USD,
} from '../config/morpho.js';
import { pathFeeBps } from '../config/uniswap.js';
import { pickSwapVenue } from '../config/aerodrome.js';
import logger from '../utils/logger.js';

const WAD = 10n ** 18n;
const BPS_DENOM = 10_000n;

// Static gas estimate for one Morpho liquidation (liquidate + swap). Replaced
// by a real estimateGas in the Executor before broadcast; used only to gate
// candidates on MIN_PROFIT_USD.
const DEFAULT_GAS_ESTIMATE = 600_000n;

// Alchemy caps eth_getLogs at 10k blocks per call on most plans.
const DEFAULT_LOG_CHUNK = 10_000n;

// Slippage haircut (bps) applied only on the *fallback* path when a live V3
// quote isn't available (Aerodrome route, or the quoter reverted). The V3
// happy path uses the quoter's exact output instead.
const FALLBACK_SLIPPAGE_BPS = 100n;

// Buffer subtracted from the live quote to set amountOutMinimum, absorbing tick
// drift between quote and inclusion. 50 bps.
const QUOTE_BUFFER_BPS = 50n;

// How long a Chainlink ETH/USD read is reused before refetching.
const DEFAULT_ETH_PRICE_TTL_MS = 5_000;

const ERC20_DECIMALS_ABI = [{
  type: 'function',
  name: 'decimals',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'uint8' }],
}];

// Subset of MorphoLiquidator.sol used to encode a transaction. Kept inline to
// keep the adapter free of forge-artifact build-step dependencies.
const AERO_ROUTE_TUPLE = {
  type: 'tuple[]',
  name: 'aeroRoutes',
  components: [
    { name: 'from',    type: 'address' },
    { name: 'to',      type: 'address' },
    { name: 'stable',  type: 'bool'    },
    { name: 'factory', type: 'address' },
  ],
};

const LIQUIDATOR_ABI = [
  {
    type: 'function',
    name: 'liquidate',
    stateMutability: 'nonpayable',
    inputs: [
      MARKET_PARAMS_TUPLE,
      { name: 'borrower',         type: 'address' },
      { name: 'seizedAssets',     type: 'uint256' },
      { name: 'swapPath',         type: 'bytes'   },
      { name: 'amountOutMinimum', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'liquidateAero',
    stateMutability: 'nonpayable',
    inputs: [
      MARKET_PARAMS_TUPLE,
      { name: 'borrower',         type: 'address' },
      { name: 'seizedAssets',     type: 'uint256' },
      AERO_ROUTE_TUPLE,
      { name: 'amountOutMinimum', type: 'uint256' },
    ],
    outputs: [],
  },
];

export class MorphoBlueAdapter extends IProtocolAdapter {
  /**
   * @param {{
   *   client?: import('viem').PublicClient,
   *   rpcUrl?: string,
   *   logsClient?: import('viem').PublicClient,
   *   morpho: `0x${string}`,
   *   markets: Array<{ id:`0x${string}`, name:string, loanToken:`0x${string}`, collateralToken:`0x${string}`, oracle:`0x${string}`, irm:`0x${string}`, lltv:bigint }>,
   *   quoter?: `0x${string}`,
   *   chainlinkEthUsd?: `0x${string}`,
   *   deployBlock?: bigint,
   *   logChunk?: bigint,
   *   gasEstimate?: bigint,
   *   liquidatorAddress?: `0x${string}`,
   *   indexLookbackBlocks?: bigint,
   *   cache?: import('../core/BorrowerCache.js').BorrowerCache,
   *   accrueInterest?: boolean,
   *   useQuoter?: boolean,
   *   shardCount?: number,
   *   forceFullEvery?: number,
   *   ethPriceTtlMs?: number,
   * }} cfg
   */
  constructor(cfg) {
    super();
    if (!cfg?.morpho) throw new Error('MorphoBlueAdapter: morpho address required');
    if (!cfg?.markets?.length) throw new Error('MorphoBlueAdapter: markets required');
    if (!cfg.client && !cfg.rpcUrl) throw new Error('MorphoBlueAdapter: client or rpcUrl required');

    this.morpho = cfg.morpho;
    // Markets keyed by lowercased id for O(1) lookup from a position back to its
    // params. `_validateMarkets` prunes this to the subset that round-trips
    // against the live singleton.
    this.markets = cfg.markets.map((m) => ({ ...m }));
    this.quoter = cfg.quoter ?? null;
    this.chainlinkEthUsd = cfg.chainlinkEthUsd ?? null;
    this.deployBlock = cfg.deployBlock ?? 0n;
    this.logChunk = cfg.logChunk ?? DEFAULT_LOG_CHUNK;
    this.gasEstimate = cfg.gasEstimate ?? DEFAULT_GAS_ESTIMATE;
    this.liquidatorAddress = cfg.liquidatorAddress ?? null;
    this.indexLookbackBlocks = cfg.indexLookbackBlocks ?? null;
    this.accrueInterest = cfg.accrueInterest ?? true;
    this.useQuoter = (cfg.useQuoter ?? true) && !!this.quoter;
    this.ethPriceTtlMs = cfg.ethPriceTtlMs ?? DEFAULT_ETH_PRICE_TTL_MS;

    this.client = cfg.client ?? createPublicClient({ chain: base, transport: http(cfg.rpcUrl) });
    this.logsClient = cfg.logsClient ?? this.client;
    this.cache = cfg.cache ?? null;

    // Sharded health scan, mirroring MoonwellAdapter: split the flat
    // (market, borrower) list into `shardCount` shards, scan one per tick, with
    // a full scan every `forceFullEvery` ticks so a newly-underwater borrower
    // can't sit unseen for long.
    this.shardCount = cfg.shardCount ?? 1;
    this.forceFullEvery = cfg.forceFullEvery ?? 30;
    this._shardCursor = 0;
    this._scanCount = 0;

    // marketId(lower) → Set<borrower>. Cache keys are `${idLower}:${borrower}`.
    /** @type {Map<string, Set<`0x${string}`>>} */
    this.borrowers = new Map();
    for (const m of this.markets) this.borrowers.set(m.id.toLowerCase(), new Set());

    // loanToken(lower) → decimals. Loaded once, lazily.
    /** @type {Map<string, number>} */
    this._loanDecimals = new Map();

    this._marketsValidated = false;
    this._ethUsd1e18 = 0n;
    this._ethUsdAt = 0;

    /** @type {Array<{ borrower: string, reason: string, market?: string }>} */
    this._silentSkips = [];
  }

  drainSilentSkips() {
    const out = this._silentSkips;
    this._silentSkips = [];
    return out;
  }

  _recordSkip(borrower, reason, market) {
    this._silentSkips.push({ borrower, reason, market });
    logger.warn('morpho.silentSkip', { borrower, reason, market });
  }

  _marketByIdLower(idLower) {
    return this.markets.find((m) => m.id.toLowerCase() === idLower) ?? null;
  }

  /**
   * Validate every configured market against the live singleton by round-
   * tripping `idToMarketParams(id)` and asserting the returned params match.
   * A market whose oracle/irm/lltv drifted (or whose loan token we can't price
   * in USD) is dropped with a loud warn so a stale config fails safe rather
   * than producing a bad liquidation. Runs once.
   */
  async _validateMarkets() {
    if (this._marketsValidated) return;

    const results = await this.client.multicall({
      contracts: this.markets.map((m) => ({
        address: this.morpho,
        abi: MORPHO_ABI,
        functionName: 'idToMarketParams',
        args: [m.id],
      })),
      allowFailure: true,
    });

    const kept = [];
    for (let i = 0; i < this.markets.length; i++) {
      const m = this.markets[i];
      const r = results[i];
      if (r?.status !== 'success') {
        logger.warn('morpho.market validation call failed — dropping', { market: m.name });
        continue;
      }
      const [loanToken, collateralToken, oracle, irm, lltv] = r.result;
      const matches =
        loanToken.toLowerCase() === m.loanToken.toLowerCase() &&
        collateralToken.toLowerCase() === m.collateralToken.toLowerCase() &&
        oracle.toLowerCase() === m.oracle.toLowerCase() &&
        irm.toLowerCase() === m.irm.toLowerCase() &&
        lltv === m.lltv;
      if (!matches) {
        logger.warn('morpho.market params mismatch — dropping (re-run verify:morpho)', {
          market: m.name, id: m.id,
        });
        continue;
      }
      if (!LOAN_TOKEN_USD[m.loanToken.toLowerCase()]) {
        logger.warn('morpho.market loan token not USD-priceable — dropping', {
          market: m.name, loanToken: m.loanToken,
        });
        continue;
      }
      kept.push(m);
    }

    // Prune borrower buckets for dropped markets.
    const keptIds = new Set(kept.map((m) => m.id.toLowerCase()));
    for (const idLower of [...this.borrowers.keys()]) {
      if (!keptIds.has(idLower)) this.borrowers.delete(idLower);
    }
    this.markets = kept;
    this._marketsValidated = true;
    logger.info('morpho.markets validated', { kept: kept.length, names: kept.map((m) => m.name) });
  }

  /**
   * Scan `Borrow` events per market for borrower (`onBehalf`) addresses.
   * Idempotent; merges into the existing cache and resumes from the cache's
   * `lastScannedBlock`.
   *
   * @returns {Promise<{ borrowerCount: number, scannedToBlock: bigint }>}
   */
  async indexBorrowers() {
    await this._validateMarkets();
    if (this.markets.length === 0) {
      logger.warn('morpho.indexBorrowers no valid markets — nothing to scan');
      return { borrowerCount: 0, scannedToBlock: 0n };
    }

    const head = await this.client.getBlockNumber();
    let from = this.deployBlock;

    if (this.cache) {
      const loaded = await this.cache.load();
      for (const key of loaded.borrowers) this._addFromCacheKey(key);
      if (loaded.lastScannedBlock > 0n && loaded.lastScannedBlock + 1n > from) {
        from = loaded.lastScannedBlock + 1n;
      }
    }

    if (this.indexLookbackBlocks !== null) {
      const recent = head > this.indexLookbackBlocks ? head - this.indexLookbackBlocks : 0n;
      if (recent > from) from = recent;
    }

    if (from > head) {
      logger.info('morpho.indexBorrowers up-to-date (cache hit)', {
        borrowerCount: this._borrowerCount(), head: head.toString(),
      });
      return { borrowerCount: this._borrowerCount(), scannedToBlock: head };
    }

    logger.info('morpho.indexBorrowers start', {
      fromBlock: from.toString(), toBlock: head.toString(),
      span: (head - from).toString(), markets: this.markets.length,
    });

    for (const m of this.markets) {
      const before = this.borrowers.get(m.id.toLowerCase()).size;
      await this._indexMarket(m, from, head);
      logger.info('morpho.indexBorrowers market scanned', {
        market: m.name,
        newBorrowers: this.borrowers.get(m.id.toLowerCase()).size - before,
        total: this.borrowers.get(m.id.toLowerCase()).size,
      });
      if (this.cache) await this._persist(0n); // preserve borrowers, don't advance block yet
    }
    if (this.cache) await this._persist(head);

    logger.info('morpho.indexBorrowers complete', {
      borrowerCount: this._borrowerCount(), scannedToBlock: head.toString(),
    });
    return { borrowerCount: this._borrowerCount(), scannedToBlock: head };
  }

  _addFromCacheKey(key) {
    const sep = key.indexOf(':');
    if (sep < 0) return;
    const idLower = key.slice(0, sep);
    const borrower = key.slice(sep + 1);
    const set = this.borrowers.get(idLower);
    if (set) set.add(borrower);
  }

  async _persist(head) {
    const keys = [];
    for (const [idLower, set] of this.borrowers) {
      for (const b of set) keys.push(`${idLower}:${b}`);
    }
    // lastScannedBlock only advances on the final save; interim saves pass 0n
    // to preserve borrowers without committing an incomplete scan cursor.
    const prev = head === 0n ? (await this.cache.load()).lastScannedBlock : head;
    await this.cache.save({ borrowers: keys, lastScannedBlock: prev });
  }

  async _indexMarket(m, fromBlock, toBlock) {
    const MIN_WINDOW = 10n;
    const set = this.borrowers.get(m.id.toLowerCase());
    let cursor = fromBlock;
    let window = this.logChunk;
    while (cursor <= toBlock) {
      const upper = cursor + window - 1n > toBlock ? toBlock : cursor + window - 1n;
      let logs;
      try {
        logs = await this.logsClient.getLogs({
          address: this.morpho,
          event: MORPHO_BORROW_EVENT,
          args: { id: m.id },
          fromBlock: cursor,
          toBlock: upper,
        });
      } catch (err) {
        const msg = err?.message ?? String(err);
        const rangeError = /range|block range|10 block|too large|exceed/i.test(msg);
        if (rangeError && window > MIN_WINDOW) {
          window = window / 2n > MIN_WINDOW ? window / 2n : MIN_WINDOW;
          continue;
        }
        throw err;
      }
      for (const log of logs) {
        const onBehalf = log.args?.onBehalf;
        if (onBehalf) set.add(onBehalf);
      }
      cursor = upper + 1n;
    }
  }

  _borrowerCount() {
    let n = 0;
    for (const set of this.borrowers.values()) n += set.size;
    return n;
  }

  /**
   * Return positions whose accrued debt exceeds their LLTV-scaled collateral
   * value. Reads market totals + oracle price + (optionally) the live borrow
   * rate per market, then multicalls `position` over the cached borrowers.
   *
   * Position shape:
   *   {
   *     protocol: 'morpho',
   *     market: { id, name, loanToken, collateralToken, oracle, irm, lltv },
   *     borrower: 0x...,
   *     borrowShares, collateral,           // raw from position()
   *     borrowAssets,                        // accrued, loan-token units
   *     collateralPrice,                     // oracle price (1e36 scaled)
   *   }
   */
  async getLiquidatable() {
    await this._validateMarkets();
    if (this.markets.length === 0) return [];
    if (this._borrowerCount() === 0) return this._logResult([], 0, true);

    const marketState = await this._loadMarketState();

    // Flatten (market, borrower) pairs, then pick this scan's slice.
    const allPairs = [];
    for (const m of this.markets) {
      const state = marketState.get(m.id.toLowerCase());
      if (!state) continue; // market read failed this tick
      for (const borrower of this.borrowers.get(m.id.toLowerCase())) {
        allPairs.push({ market: m, state, borrower });
      }
    }
    if (allPairs.length === 0) return this._logResult([], 0, true);

    const isFullScan = this.shardCount <= 1
      || this._scanCount === 0
      || (this._scanCount % this.forceFullEvery) === 0;
    const pairs = isFullScan ? allPairs : this._shardOf(allPairs, this._shardCursor);
    this._shardCursor = (this._shardCursor + 1) % this.shardCount;
    this._scanCount += 1;

    const positions = await this._filterUnhealthy(pairs);
    return this._logResult(positions, pairs.length, isFullScan);
  }

  _shardOf(pairs, shardIdx) {
    const out = [];
    for (let i = shardIdx; i < pairs.length; i += this.shardCount) out.push(pairs[i]);
    return out;
  }

  // Per-market: market() totals + oracle.price(), then (optional) a second
  // multicall for borrowRateView to accrue interest forward from lastUpdate.
  async _loadMarketState() {
    const calls = [];
    for (const m of this.markets) {
      calls.push({ address: this.morpho, abi: MORPHO_ABI, functionName: 'market', args: [m.id] });
      calls.push({ address: m.oracle, abi: MORPHO_ORACLE_ABI, functionName: 'price' });
    }
    const results = await this.client.multicall({ contracts: calls, allowFailure: true });

    const state = new Map();
    const raw = [];
    for (let i = 0; i < this.markets.length; i++) {
      const m = this.markets[i];
      const marketRes = results[i * 2];
      const priceRes = results[i * 2 + 1];
      if (marketRes?.status !== 'success' || priceRes?.status !== 'success') {
        logger.warn('morpho.marketState read failed', { market: m.name });
        continue;
      }
      const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = marketRes.result;
      raw.push({
        m,
        struct: { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee },
        price: priceRes.result,
      });
    }

    // Accrue interest so a stale market doesn't under-count debt. Best-effort:
    // if borrowRateView reverts we fall back to the stored totals.
    let rates = null;
    if (this.accrueInterest && raw.length > 0) {
      try {
        rates = await this.client.multicall({
          contracts: raw.map(({ m, struct }) => ({
            address: m.irm,
            abi: MORPHO_IRM_ABI,
            functionName: 'borrowRateView',
            args: [marketParamsTuple(m), struct],
          })),
          allowFailure: true,
        });
      } catch (err) {
        logger.warn('morpho.borrowRateView batch failed — using stored totals', { error: err?.message });
      }
    }

    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    for (let i = 0; i < raw.length; i++) {
      const { m, struct, price } = raw[i];
      let accruedBorrowAssets = struct.totalBorrowAssets;
      const rate = rates?.[i]?.status === 'success' ? rates[i].result : null;
      if (rate != null && struct.totalBorrowAssets > 0n && nowSec > struct.lastUpdate) {
        const elapsed = nowSec - struct.lastUpdate;
        const interest = wMulDown(struct.totalBorrowAssets, wTaylorCompounded(rate, elapsed));
        accruedBorrowAssets = struct.totalBorrowAssets + interest;
      }
      state.set(m.id.toLowerCase(), {
        totalBorrowAssets: accruedBorrowAssets,
        totalBorrowShares: struct.totalBorrowShares,
        collateralPrice: price,
      });
    }
    return state;
  }

  async _filterUnhealthy(pairs) {
    const results = await this.client.multicall({
      contracts: pairs.map(({ market, borrower }) => ({
        address: this.morpho,
        abi: MORPHO_ABI,
        functionName: 'position',
        args: [market.id, borrower],
      })),
      allowFailure: true,
    });

    const out = [];
    for (let i = 0; i < pairs.length; i++) {
      const { market, state, borrower } = pairs[i];
      const r = results[i];
      if (r?.status !== 'success') {
        this._recordSkip(borrower, 'position() read failed', market.name);
        continue;
      }
      const [, borrowShares, collateral] = r.result;
      if (borrowShares === 0n || collateral === 0n) continue;

      const borrowAssets = toAssetsUp(borrowShares, state.totalBorrowAssets, state.totalBorrowShares);
      // maxBorrow = collateral * price / 1e36 * lltv / 1e18. Healthy iff
      // maxBorrow >= borrowAssets (Morpho's _isHealthy).
      const collateralValueLoan = (collateral * state.collateralPrice) / ORACLE_PRICE_SCALE;
      const maxBorrow = wMulDown(collateralValueLoan, market.lltv);
      if (borrowAssets <= maxBorrow) continue;

      out.push({
        protocol: 'morpho',
        market: {
          id: market.id,
          name: market.name,
          loanToken: market.loanToken,
          collateralToken: market.collateralToken,
          oracle: market.oracle,
          irm: market.irm,
          lltv: market.lltv,
        },
        borrower,
        borrowShares,
        collateral,
        borrowAssets,
        collateralPrice: state.collateralPrice,
      });
    }
    return out;
  }

  _logResult(positions, scanned, isFullScan) {
    logger.info('morpho.getLiquidatable complete', {
      markets: this.markets.length,
      total: this._borrowerCount(),
      scanned,
      shard: isFullScan ? 'full' : `${(this._shardCursor + this.shardCount - 1) % this.shardCount}/${this.shardCount}`,
      liquidatable: positions.length,
    });
    return positions;
  }

  /**
   * Project the USD profit of liquidating `position`.
   *
   * Morpho's liquidation-incentive factor (LIF) is derived from the market's
   * LLTV, not a flat bonus:
   *   LIF = min(MAX_LIF, 1 / (1 - CURSOR * (1 - lltv)))   (all WAD math)
   *
   * Seizing `seizedAssets` of collateral repays
   *   repay = seizedValueInLoan / LIF
   * so the liquidator's gross edge is `seizedValueInLoan - repay`. Because
   * Morpho's callback funds the repay from the swap output, there's no flash-
   * loan premium — only the collateral→loan swap cost (priced live via
   * QuoterV2) and gas.
   *
   * @param {object} position Position emitted by getLiquidatable().
   * @returns {Promise<{ profitUsd:number, gasCostUsd:number, netUsd:number, tradeCostsUsd:number, ethUsd1e18:bigint, venue?:string }>}
   */
  async estimateProfit(position) {
    await this._loadLoanDecimals();
    const { market, collateral, collateralPrice, borrowAssets } = position;
    const loanLower = market.loanToken.toLowerCase();

    const lif = liquidationIncentiveFactor(market.lltv);

    // Repay that seizes *all* collateral; cap by the actual debt.
    const collateralValueLoan = (collateral * collateralPrice) / ORACLE_PRICE_SCALE;
    const maxRepayFromCollateral = wDivDown(collateralValueLoan, lif);
    const effectiveRepay = borrowAssets < maxRepayFromCollateral ? borrowAssets : maxRepayFromCollateral;
    if (effectiveRepay === 0n) return this._zeroEstimate(position);

    // Collateral (raw units) seized for that repay.
    const seizedValueLoan = wMulDown(effectiveRepay, lif);
    let seizedAssets = mulDivDown(seizedValueLoan, ORACLE_PRICE_SCALE, collateralPrice);
    if (seizedAssets > collateral) seizedAssets = collateral;
    if (seizedAssets === 0n) return this._zeroEstimate(position);

    // Route the seized collateral back to the loan token.
    const venuePick = pickSwapVenue(market.collateralToken, market.loanToken);
    if (venuePick === null) {
      this._recordSkip(position.borrower, 'no swap route (V3 or AERO)', market.name);
      return this._zeroEstimate(position);
    }

    // Swap output: live V3 quote when available, else static haircut.
    const { swapOutLoan, amountOutMinimum } = await this._swapOutput(
      venuePick, market, seizedAssets, seizedValueLoan, effectiveRepay,
    );

    const ethUsd1e18 = await this._getEthUsd();
    const gasCostUsd1e18 = await this._estimateGasUsd(ethUsd1e18);

    // Gross edge and net (after swap cost), both in loan-token units, then USD.
    const grossProfitLoan = seizedValueLoan > effectiveRepay ? seizedValueLoan - effectiveRepay : 0n;
    const netProfitLoan = swapOutLoan > effectiveRepay ? swapOutLoan - effectiveRepay : 0n;
    const swapCostLoan = grossProfitLoan > netProfitLoan ? grossProfitLoan - netProfitLoan : 0n;

    const grossProfitUsd1e18 = this._loanToUsd1e18(grossProfitLoan, loanLower, ethUsd1e18);
    const tradeCostsUsd1e18  = this._loanToUsd1e18(swapCostLoan, loanLower, ethUsd1e18);
    const net1e18 = grossProfitUsd1e18 - tradeCostsUsd1e18 - gasCostUsd1e18;

    position._plan = {
      marketParams: marketParamsTuple(market),
      borrower: position.borrower,
      seizedAssets,
      venue: venuePick.venue,
      swapPath: venuePick.swapPath ?? null,
      aeroRoutes: venuePick.aeroRoutes ?? null,
      amountOutMinimum,
    };

    const result = {
      profitUsd: wadToFloat(grossProfitUsd1e18),
      gasCostUsd: wadToFloat(gasCostUsd1e18),
      netUsd: wadToFloat(net1e18),
      tradeCostsUsd: wadToFloat(tradeCostsUsd1e18),
      ethUsd1e18,
      venue: venuePick.venue,
    };
    logger.debug('morpho.estimateProfit', {
      borrower: position.borrower, market: market.name, ...result,
    });
    return result;
  }

  _zeroEstimate(position) {
    return {
      profitUsd: 0, gasCostUsd: 0, netUsd: 0, tradeCostsUsd: 0,
      ethUsd1e18: this._ethUsd1e18,
    };
  }

  // Returns { swapOutLoan, amountOutMinimum } (both loan-token base units).
  // V3: exact live quote from QuoterV2; amountOutMinimum = quote - buffer.
  // Fallback (Aerodrome, or quoter reverted): static fee+slippage haircut.
  async _swapOutput(venuePick, market, seizedAssets, seizedValueLoan, effectiveRepay) {
    if (venuePick.venue === 'V3' && this.useQuoter && venuePick.swapPath && venuePick.swapPath !== '0x') {
      try {
        const { result } = await this.client.simulateContract({
          address: this.quoter,
          abi: QUOTER_V2_ABI,
          functionName: 'quoteExactInput',
          args: [venuePick.swapPath, seizedAssets],
        });
        const swapOutLoan = result[0];
        const amountOutMinimum = (swapOutLoan * (BPS_DENOM - QUOTE_BUFFER_BPS)) / BPS_DENOM;
        return { swapOutLoan, amountOutMinimum };
      } catch (err) {
        logger.debug('morpho.quoter reverted — falling back to static haircut', {
          market: market.name, error: err?.shortMessage ?? err?.message,
        });
      }
    }

    // Static fallback: subtract pool fee (V3 only) + a conservative slippage
    // haircut from the oracle-implied seized value.
    const feeBps = venuePick.venue === 'V3'
      ? pathFeeBps(market.collateralToken, market.loanToken)
      : 0n;
    const haircutBps = feeBps + FALLBACK_SLIPPAGE_BPS;
    const swapOutLoan = (seizedValueLoan * (BPS_DENOM - haircutBps)) / BPS_DENOM;
    // amountOutMinimum must still clear the repay; use the haircut estimate.
    const amountOutMinimum = swapOutLoan;
    return { swapOutLoan, amountOutMinimum };
  }

  /**
   * Encode a MorphoLiquidator.{liquidate,liquidateAero} transaction from the
   * plan stamped by estimateProfit. Pure — no RPC.
   *
   * @param {object} position Position with `_plan` set by estimateProfit().
   * @returns {{ to:`0x${string}`, data:`0x${string}`, value:bigint }}
   */
  buildLiquidationCall(position) {
    if (!position?._plan) {
      throw new Error('MorphoBlueAdapter.buildLiquidationCall: call estimateProfit(position) first');
    }
    const to = this.liquidatorAddress;
    if (!to) throw new Error('MorphoBlueAdapter.buildLiquidationCall: liquidatorAddress required');

    const { marketParams, borrower, seizedAssets, venue, swapPath, aeroRoutes, amountOutMinimum } = position._plan;
    if (!venue) {
      throw new Error('MorphoBlueAdapter.buildLiquidationCall: _plan.venue missing — estimateProfit picked an unroutable pair');
    }

    let data;
    if (venue === 'V3') {
      if (!swapPath) throw new Error('MorphoBlueAdapter.buildLiquidationCall: V3 venue without swapPath');
      data = encodeFunctionData({
        abi: LIQUIDATOR_ABI,
        functionName: 'liquidate',
        args: [marketParams, borrower, seizedAssets, swapPath, amountOutMinimum ?? 0n],
      });
    } else if (venue === 'AERO') {
      if (!aeroRoutes?.length) throw new Error('MorphoBlueAdapter.buildLiquidationCall: AERO venue without aeroRoutes');
      data = encodeFunctionData({
        abi: LIQUIDATOR_ABI,
        functionName: 'liquidateAero',
        args: [marketParams, borrower, seizedAssets, aeroRoutes, amountOutMinimum ?? 0n],
      });
    } else {
      throw new Error(`MorphoBlueAdapter.buildLiquidationCall: unknown venue ${venue}`);
    }
    return { to, data, value: 0n };
  }

  async _loadLoanDecimals() {
    const loanTokens = [...new Set(this.markets.map((m) => m.loanToken.toLowerCase()))]
      .filter((t) => !this._loanDecimals.has(t));
    if (loanTokens.length === 0) return;
    const results = await this.client.multicall({
      contracts: loanTokens.map((t) => ({ address: t, abi: ERC20_DECIMALS_ABI, functionName: 'decimals' })),
      allowFailure: true,
    });
    for (let i = 0; i < loanTokens.length; i++) {
      const r = results[i];
      if (r?.status === 'success') this._loanDecimals.set(loanTokens[i], Number(r.result));
    }
  }

  async _getEthUsd() {
    const now = Date.now();
    if (this._ethUsd1e18 > 0n && now - this._ethUsdAt < this.ethPriceTtlMs) return this._ethUsd1e18;
    if (!this.chainlinkEthUsd) return this._ethUsd1e18;
    try {
      const [rd, dec] = await this.client.multicall({
        contracts: [
          { address: this.chainlinkEthUsd, abi: CHAINLINK_AGGREGATOR_ABI, functionName: 'latestRoundData' },
          { address: this.chainlinkEthUsd, abi: CHAINLINK_AGGREGATOR_ABI, functionName: 'decimals' },
        ],
        allowFailure: true,
      });
      if (rd?.status !== 'success') return this._ethUsd1e18;
      const answer = rd.result[1];
      if (answer <= 0n) return this._ethUsd1e18;
      const decimals = dec?.status === 'success' ? BigInt(dec.result) : 8n;
      this._ethUsd1e18 = (answer * WAD) / (10n ** decimals);
      this._ethUsdAt = now;
    } catch (err) {
      logger.warn('morpho.ethUsd read failed', { error: err?.message });
    }
    return this._ethUsd1e18;
  }

  async _estimateGasUsd(ethUsd1e18) {
    if (!ethUsd1e18) return 0n;
    const gasPriceWei = await this.client.getGasPrice();
    return (gasPriceWei * this.gasEstimate * ethUsd1e18) / WAD;
  }

  // loan-token base units → USD scaled 1e18.
  _loanToUsd1e18(amountBase, loanLower, ethUsd1e18) {
    if (amountBase === 0n) return 0n;
    const dec = this._loanDecimals.get(loanLower);
    if (dec == null) return 0n;
    const info = LOAN_TOKEN_USD[loanLower];
    let usdPerUnit1e18;
    if (info?.kind === 'STABLE') usdPerUnit1e18 = WAD * BigInt(info.usd);
    else if (info?.kind === 'ETH') usdPerUnit1e18 = ethUsd1e18;
    else return 0n;
    return (amountBase * usdPerUnit1e18) / (10n ** BigInt(dec));
  }
}

// ---- Morpho fixed-point helpers (mirror src/libraries/MathLib.sol) ----

function wMulDown(x, y) { return (x * y) / WAD; }
function wDivDown(x, y) { return (x * WAD) / y; }
function mulDivDown(x, y, d) { return (x * y) / d; }
function mulDivUp(x, y, d) { return (x * y + (d - 1n)) / d; }

// shares → assets, rounding up (Morpho SharesMathLib.toAssetsUp).
function toAssetsUp(shares, totalAssets, totalShares) {
  return mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
}

// Taylor expansion of e^(rate*t) - 1 to the 3rd order (Morpho MathLib).
function wTaylorCompounded(rate, t) {
  const firstTerm = rate * t;
  const secondTerm = mulDivDown(firstTerm, firstTerm, 2n * WAD);
  const thirdTerm = mulDivDown(secondTerm, firstTerm, 3n * WAD);
  return firstTerm + secondTerm + thirdTerm;
}

// LIF = min(MAX_LIF, WAD / (WAD - CURSOR*(WAD - lltv)))  (Morpho liquidate()).
function liquidationIncentiveFactor(lltv) {
  const denom = WAD - wMulDown(LIQUIDATION_CURSOR, WAD - lltv);
  const lif = wDivDown(WAD, denom);
  return lif < MAX_LIQUIDATION_INCENTIVE_FACTOR ? lif : MAX_LIQUIDATION_INCENTIVE_FACTOR;
}

// Build the MarketParams tuple object viem encodes for calldata / IRM args.
function marketParamsTuple(m) {
  return {
    loanToken: m.loanToken,
    collateralToken: m.collateralToken,
    oracle: m.oracle,
    irm: m.irm,
    lltv: m.lltv,
  };
}

function wadToFloat(wad) {
  const sign = wad < 0n ? -1 : 1;
  const abs = wad < 0n ? -wad : wad;
  const whole = Number(abs / WAD);
  const frac = Number(abs % WAD) / 1e18;
  return sign * (whole + frac);
}
