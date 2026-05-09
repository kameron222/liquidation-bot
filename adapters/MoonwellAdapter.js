/**
 * MoonwellAdapter — IProtocolAdapter implementation for Moonwell on Base.
 *
 * Stage 1: borrower indexing via Borrow event scan.
 * Stage 2: getLiquidatable() — Comptroller.getAccountLiquidity over the cached
 *          borrowers via multicall, then assets-in + per-mToken
 *          borrowBalanceCurrent / balanceOf for each shortfall>0 account.
 * Stage 3: estimateProfit() — protocol params + oracle prices + exchangeRates,
 *          best (debt, collateral) pair, capped by closeFactor and the
 *          collateral USD that's actually present, gas converted via mWETH.
 *
 * Construction:
 *   import { MOONWELL_BASE } from '../config/moonwell.js';
 *   const adapter = new MoonwellAdapter({
 *     rpcUrl: process.env.ALCHEMY_HTTP_URL,
 *     comptroller: MOONWELL_BASE.comptroller,
 *     mTokens: MOONWELL_BASE.mTokens,
 *     deployBlock: MOONWELL_BASE.deployBlock,
 *   });
 *   await adapter.indexBorrowers();
 *   const positions = await adapter.getLiquidatable();
 *
 * Tests inject `client` directly to avoid hitting the network.
 */

import { createPublicClient, http, encodeFunctionData } from 'viem';
import { base } from 'viem/chains';
import { IProtocolAdapter } from './IProtocolAdapter.js';
import { COMPTROLLER_ABI } from '../config/abis/Comptroller.js';
import { MTOKEN_ABI } from '../config/abis/MToken.js';
import { PRICE_ORACLE_ABI } from '../config/abis/PriceOracle.js';
import { pathFeeBps, TOKENS_BASE } from '../config/uniswap.js';
import { pickSwapVenue } from '../config/aerodrome.js';
import { FLASH_LOAN_PREMIUM_BPS } from '../config/aave.js';
import logger from '../utils/logger.js';

// Aerodrome's pool fee + slippage are bundled into a single haircut: pool
// depth on Solidly forks varies more than V3, so a per-pair-fee table
// would be misleading precision. 100 bps covers fee + slippage for any
// route this bot picks; the on-chain `amountOutMinimum` enforces it.
const AERO_HAIRCUT_BPS = 100n;

// Minimal ERC20 ABI fragment for the one-shot decimals() lookup we do at
// startup. Not worth promoting to its own file.
const ERC20_DECIMALS_ABI = [{
  type: 'function',
  name: 'decimals',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'uint8' }],
}];

// Slippage haircut in bps applied off-chain when ranking pairs. Indexed by
// the *less liquid* token in the pair. Numbers are deliberately conservative —
// we'd rather skip a marginal candidate than chase one that nets negative
// once the on-chain swap settles.
const SLIPPAGE_BPS_BY_TOKEN = (() => {
  const lc = (a) => a.toLowerCase();
  const tight = new Set([
    TOKENS_BASE.WETH, TOKENS_BASE.USDC, TOKENS_BASE.USDbC, TOKENS_BASE.DAI,
    TOKENS_BASE.cbETH, TOKENS_BASE.wstETH, TOKENS_BASE.weETH, TOKENS_BASE.rETH,
    TOKENS_BASE.cbBTC, TOKENS_BASE.EURC, TOKENS_BASE.USDS,
  ].map(lc));
  return (addrA, addrB) => {
    const a = lc(addrA), b = lc(addrB);
    if (a === b) return 0n;
    if (tight.has(a) && tight.has(b)) return 15n;
    return 75n; // long-tail leg present
  };
})();

// Subset of Liquidator.sol used to encode a transaction. Kept inline (rather
// than imported from forge artifacts) to keep this adapter free of build-step
// dependencies.
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
      { name: 'borrower',         type: 'address' },
      { name: 'mTokenBorrow',     type: 'address' },
      { name: 'mTokenCollateral', type: 'address' },
      { name: 'repayAmount',      type: 'uint256' },
      { name: 'swapPath',         type: 'bytes' },
      { name: 'amountOutMinimum', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'liquidateAero',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'borrower',         type: 'address' },
      { name: 'mTokenBorrow',     type: 'address' },
      { name: 'mTokenCollateral', type: 'address' },
      { name: 'repayAmount',      type: 'uint256' },
      AERO_ROUTE_TUPLE,
      { name: 'amountOutMinimum', type: 'uint256' },
    ],
    outputs: [],
  },
];

const WAD = 1_000_000_000_000_000_000n; // 1e18

// Static gas estimate for one liquidation tx (Stage 4 will replace with a
// real estimateGas against the deployed Liquidator contract).
const DEFAULT_GAS_ESTIMATE = 750_000n;

// Compound v2 / Moonwell Borrow event. `borrower` is NOT indexed in v2, so we
// can only filter by contract address + event signature; decoded args carry
// the borrower.
const BORROW_EVENT = {
  type: 'event',
  name: 'Borrow',
  inputs: [
    { name: 'borrower',       type: 'address', indexed: false },
    { name: 'borrowAmount',   type: 'uint256', indexed: false },
    { name: 'accountBorrows', type: 'uint256', indexed: false },
    { name: 'totalBorrows',   type: 'uint256', indexed: false },
  ],
};

// Alchemy caps eth_getLogs at 10k blocks per call on most plans.
const DEFAULT_LOG_CHUNK = 10_000n;

export class MoonwellAdapter extends IProtocolAdapter {
  /**
   * @param {{
   *   client?: import('viem').PublicClient,
   *   rpcUrl?: string,
   *   comptroller: `0x${string}`,
   *   mTokens: Array<{ symbol: string, address: `0x${string}`, underlying: string }>,
   *   deployBlock?: bigint,
   *   logChunk?: bigint,
   *   gasEstimate?: bigint,
   *   liquidatorAddress?: `0x${string}`,
   *   logsClient?: import('viem').PublicClient,
   *   indexLookbackBlocks?: bigint,
   *   cache?: import('../core/BorrowerCache.js').BorrowerCache,
   *   tokenCache?: import('../core/TokenMetadataCache.js').TokenMetadataCache,
   * }} cfg
   */
  constructor(cfg) {
    super();
    if (!cfg?.comptroller) throw new Error('MoonwellAdapter: comptroller required');
    if (!cfg?.mTokens?.length) throw new Error('MoonwellAdapter: mTokens required');
    if (!cfg.client && !cfg.rpcUrl) throw new Error('MoonwellAdapter: client or rpcUrl required');

    this.comptroller = cfg.comptroller;
    this.mTokens = cfg.mTokens;
    this.deployBlock = cfg.deployBlock ?? 0n;
    this.logChunk = cfg.logChunk ?? DEFAULT_LOG_CHUNK;
    this.gasEstimate = cfg.gasEstimate ?? DEFAULT_GAS_ESTIMATE;
    this.liquidatorAddress = cfg.liquidatorAddress ?? null;
    // Optional cap on history scanned per indexBorrowers run. When unset,
    // scans from `deployBlock`. Useful when the log RPC has small per-call
    // ranges and full-history bootstrap is too slow.
    this.indexLookbackBlocks = cfg.indexLookbackBlocks ?? null;
    this.client = cfg.client ?? createPublicClient({
      chain: base,
      transport: http(cfg.rpcUrl),
    });
    // Separate client used only for `eth_getLogs`. Free Alchemy plans cap
    // ranges at 10 blocks; routing logs through a public Base RPC sidesteps
    // that without giving up Alchemy for multicalls. Falls back to `client`.
    this.logsClient = cfg.logsClient ?? this.client;
    this.cache = cfg.cache ?? null;
    this.tokenCache = cfg.tokenCache ?? null;

    this._wethMToken = cfg.mTokens.find((m) => m.underlying === 'WETH')?.address ?? null;

    // Sharded shortfall scan. With ~1300 borrowers and a 2s block cadence,
    // checking every borrower every block burns RPC budget. Round-robin across
    // `shardCount` shards, one shard per call. `forceFullEvery` calls a full
    // scan periodically so newly-underwater borrowers can't sit unseen for
    // long. When `shardCount === 1` (default) behavior is unchanged.
    this.shardCount = cfg.shardCount ?? 1;
    this.forceFullEvery = cfg.forceFullEvery ?? 30;
    this._shardCursor = 0;
    this._scanCount = 0;

    /** @type {Set<`0x${string}`>} */
    this.borrowers = new Set();

    // mToken (lowercase) → { underlying, decimals, symbol }. Populated by
    // _loadTokenMetadata() lazily on first estimateProfit, or eagerly by
    // indexBorrowers() during startup. `_tokenMetaPromise` memoises the
    // in-flight load so concurrent estimateProfit calls share one fetch.
    /** @type {Map<string, { underlying: `0x${string}`, decimals: number, symbol: string }>} */
    this._tokenMeta = new Map();
    this._tokenMetaPromise = null;

    // Per-tick aggregation of "silent" pair-level skips (no swap path,
    // missing oracle/meta, balance multicall failure, etc). Drained by the
    // monitor at the end of each tick so a single warn embed surfaces
    // anything we'd otherwise lose. Each entry: { borrower, reason, debt, collateral }.
    /** @type {Array<{ borrower: string, reason: string, debt?: string, collateral?: string }>} */
    this._silentSkips = [];
  }

  /**
   * Drain the per-tick silent-skip buffer. Returns the array of reasons
   * collected since the last call and resets internal state. Called by
   * PositionMonitor once per tick to surface aggregate observability.
   *
   * @returns {Array<{ borrower: string, reason: string, debt?: string, collateral?: string }>}
   */
  drainSilentSkips() {
    const out = this._silentSkips;
    this._silentSkips = [];
    return out;
  }

  _recordSkip(borrower, reason, debt, collateral) {
    this._silentSkips.push({ borrower, reason, debt, collateral });
    logger.warn('moonwell.silentSkip', { borrower, reason, debt, collateral });
  }

  /**
   * Scan Borrow events from each mToken to discover unique borrower addresses.
   * Idempotent: re-running merges into the existing cache.
   *
   * @returns {Promise<{ borrowerCount: number, scannedToBlock: bigint }>}
   */
  async indexBorrowers() {
    const head = await this.client.getBlockNumber();
    let from = this.deployBlock;

    // Cache: warm-start with previously discovered borrowers and resume the
    // scan from `lastScannedBlock + 1`. A cache hit beats both the lookback
    // window and the deploy block.
    if (this.cache) {
      const loaded = await this.cache.load();
      for (const b of loaded.borrowers) this.borrowers.add(b);
      if (loaded.lastScannedBlock > 0n && loaded.lastScannedBlock + 1n > from) {
        from = loaded.lastScannedBlock + 1n;
      }
    }

    if (this.indexLookbackBlocks !== null) {
      const recent = head > this.indexLookbackBlocks ? head - this.indexLookbackBlocks : 0n;
      if (recent > from) from = recent;
    }

    if (from > head) {
      logger.info('moonwell.indexBorrowers up-to-date (cache hit)', {
        borrowerCount: this.borrowers.size,
        head: head.toString(),
      });
      return { borrowerCount: this.borrowers.size, scannedToBlock: head };
    }

    logger.info('moonwell.indexBorrowers start', {
      fromBlock: from.toString(),
      toBlock: head.toString(),
      span: (head - from).toString(),
      cached: this.cache ? this.borrowers.size : 0,
    });
    // The borrower set is append-only across mTokens, so we persist after
    // each mToken to preserve work on a crash. `lastScannedBlock` is only
    // committed after all mTokens finish, otherwise a crash mid-run would
    // make the next start skip the un-scanned mTokens entirely.
    const cachedLastBlock = this.cache ? (await this.cache.load()).lastScannedBlock : 0n;
    for (const mToken of this.mTokens) {
      const before = this.borrowers.size;
      await this._indexFromMToken(mToken, from, head);
      logger.info('moonwell.indexBorrowers mToken scanned', {
        symbol: mToken.symbol,
        newBorrowers: this.borrowers.size - before,
        totalBorrowers: this.borrowers.size,
      });
      if (this.cache) {
        await this.cache.save({ borrowers: this.borrowers, lastScannedBlock: cachedLastBlock });
      }
    }
    if (this.cache) {
      await this.cache.save({ borrowers: this.borrowers, lastScannedBlock: head });
    }
    logger.info('moonwell.indexBorrowers complete', {
      borrowerCount: this.borrowers.size,
      scannedToBlock: head.toString(),
    });
    return { borrowerCount: this.borrowers.size, scannedToBlock: head };
  }

  async _indexFromMToken(mToken, fromBlock, toBlock) {
    await this._indexViaRpc(mToken, fromBlock, toBlock);
  }

  async _indexViaRpc(mToken, fromBlock, toBlock) {
    const MIN_WINDOW = 10n;
    const span = toBlock >= fromBlock ? toBlock - fromBlock + 1n : 0n;
    let cursor = fromBlock;
    let window = this.logChunk;
    let chunkCount = 0;
    while (cursor <= toBlock) {
      const upper = cursor + window - 1n > toBlock ? toBlock : cursor + window - 1n;
      let logs;
      try {
        logs = await this.logsClient.getLogs({
          address: mToken.address,
          event: BORROW_EVENT,
          fromBlock: cursor,
          toBlock: upper,
        });
      } catch (err) {
        // Adaptive: if the RPC rejects the range as too wide, halve and retry.
        const msg = err?.message ?? String(err);
        const rangeError = /range|block range|10 block|too large|exceed/i.test(msg);
        if (rangeError && window > MIN_WINDOW) {
          window = window / 2n > MIN_WINDOW ? window / 2n : MIN_WINDOW;
          continue;
        }
        throw err;
      }
      for (const log of logs) {
        const borrower = log.args?.borrower;
        if (borrower) this.borrowers.add(borrower);
      }
      cursor = upper + 1n;
      chunkCount++;
      if (chunkCount % 10 === 0 && span > 0n) {
        const done = cursor > fromBlock ? cursor - fromBlock : 0n;
        logger.info('moonwell.indexBorrowers progress', {
          symbol: mToken.symbol,
          cursor: cursor.toString(),
          toBlock: toBlock.toString(),
          pctDone: ((done * 100n) / span).toString(),
          window: window.toString(),
          found: this.borrowers.size,
        });
      }
    }
  }

  /**
   * Return cached borrowers whose Comptroller shortfall is > 0, with the
   * mTokens they have entered as collateral and the per-mToken debt and
   * collateral balances. Pure read: makes 1–3 multicall round-trips and never
   * touches the borrower cache.
   *
   * Position shape:
   *   {
   *     protocol: 'moonwell',
   *     borrower: 0x...,
   *     shortfall: bigint,            // Comptroller-reported $shortfall in 1e18
   *     liquidity: bigint,            // typically 0 when shortfall > 0
   *     debts:       [{ mToken, symbol, amount }],     // borrowBalanceCurrent
   *     collaterals: [{ mToken, symbol, cTokenAmount }] // mToken.balanceOf
   *   }
   *
   * @returns {Promise<Array<object>>}
   */
  async getLiquidatable() {
    const allBorrowers = [...this.borrowers];
    if (allBorrowers.length === 0) return [];

    // Pick the slice for this scan: full set on the first call and every
    // `forceFullEvery`-th call thereafter; otherwise just one shard. Shard
    // boundaries are stable across scans so a given borrower is checked on
    // the same offsets each cycle.
    const isFullScan = this.shardCount <= 1
      || this._scanCount === 0
      || (this._scanCount % this.forceFullEvery) === 0;
    const borrowers = isFullScan
      ? allBorrowers
      : this._shardOf(allBorrowers, this._shardCursor);
    this._shardCursor = (this._shardCursor + 1) % this.shardCount;
    this._scanCount += 1;

    const liquidatable = await this._filterByShortfall(borrowers);
    if (liquidatable.length === 0) return this._logResult([], borrowers.length, isFullScan);

    const assetIndex = await this._loadAssetsIn(liquidatable);
    await this._loadDebtAndCollateralBalances(liquidatable, assetIndex);

    return this._logResult(liquidatable.map((p) => ({
      protocol: 'moonwell',
      borrower: p.borrower,
      shortfall: p.shortfall,
      liquidity: p.liquidity,
      debts: p.debts,
      collaterals: p.collaterals,
    })), borrowers.length, isFullScan);
  }

  // Deterministic shard: keeps shard boundaries stable across calls so each
  // borrower lands in the same shard until the borrower set changes.
  _shardOf(borrowers, shardIdx) {
    const out = [];
    for (let i = shardIdx; i < borrowers.length; i += this.shardCount) {
      out.push(borrowers[i]);
    }
    return out;
  }

  async _filterByShortfall(borrowers) {
    const results = await this.client.multicall({
      contracts: borrowers.map((b) => ({
        address: this.comptroller,
        abi: COMPTROLLER_ABI,
        functionName: 'getAccountLiquidity',
        args: [b],
      })),
      allowFailure: true,
    });

    const out = [];
    for (let i = 0; i < borrowers.length; i++) {
      const r = results[i];
      if (r.status !== 'success') continue;
      const [error, liquidity, shortfall] = r.result;
      if (error !== 0n) continue;
      if (shortfall > 0n) {
        out.push({ borrower: borrowers[i], liquidity, shortfall });
      }
    }
    return out;
  }

  async _loadAssetsIn(positions) {
    const results = await this.client.multicall({
      contracts: positions.map((p) => ({
        address: this.comptroller,
        abi: COMPTROLLER_ABI,
        functionName: 'getAssetsIn',
        args: [p.borrower],
      })),
      allowFailure: true,
    });

    const assetIndex = []; // { positionIdx, mToken }
    for (let i = 0; i < positions.length; i++) {
      const r = results[i];
      const assets = r.status === 'success' ? r.result : [];
      positions[i].assetsIn = assets;
      positions[i].debts = [];
      positions[i].collaterals = [];
      for (const mToken of assets) assetIndex.push({ positionIdx: i, mToken });
    }
    return assetIndex;
  }

  async _loadDebtAndCollateralBalances(positions, assetIndex) {
    if (assetIndex.length === 0) return;

    const calls = [];
    for (const { positionIdx, mToken } of assetIndex) {
      const borrower = positions[positionIdx].borrower;
      calls.push({
        address: mToken,
        abi: MTOKEN_ABI,
        functionName: 'borrowBalanceCurrent',
        args: [borrower],
      });
      calls.push({
        address: mToken,
        abi: MTOKEN_ABI,
        functionName: 'balanceOf',
        args: [borrower],
      });
    }

    const results = await this.client.multicall({ contracts: calls, allowFailure: true });

    const symbolByAddress = new Map(this.mTokens.map((m) => [m.address.toLowerCase(), m.symbol]));
    for (let k = 0; k < assetIndex.length; k++) {
      const { positionIdx, mToken } = assetIndex[k];
      const borrowResult = results[k * 2];
      const balanceResult = results[k * 2 + 1];
      const symbol = symbolByAddress.get(mToken.toLowerCase()) ?? '?';
      const borrower = positions[positionIdx].borrower;

      if (borrowResult?.status === 'success' && borrowResult.result > 0n) {
        positions[positionIdx].debts.push({
          mToken,
          symbol,
          amount: borrowResult.result,
        });
      } else if (borrowResult?.status !== 'success') {
        this._recordSkip(borrower, `borrowBalanceCurrent failed (${symbol})`, symbol);
      }
      if (balanceResult?.status === 'success' && balanceResult.result > 0n) {
        positions[positionIdx].collaterals.push({
          mToken,
          symbol,
          cTokenAmount: balanceResult.result,
        });
      } else if (balanceResult?.status !== 'success') {
        this._recordSkip(borrower, `mToken.balanceOf failed (${symbol})`, undefined, symbol);
      }
    }
  }

  _logResult(positions, scanned = this.borrowers.size, isFullScan = true) {
    logger.info('moonwell.getLiquidatable complete', {
      total: this.borrowers.size,
      scanned,
      shard: isFullScan ? 'full' : `${(this._shardCursor + this.shardCount - 1) % this.shardCount}/${this.shardCount}`,
      liquidatable: positions.length,
    });
    return positions;
  }

  /**
   * Project the USD profit of liquidating `position`. Picks the (debt,
   * collateral) pair that maximises **net** profit after gas, the Aave flash-
   * loan premium, the Uniswap V3 pool fee along the chosen swap path, and a
   * conservative slippage haircut. The chosen pair's swap path is stamped on
   * `position._plan` for `buildLiquidationCall` to consume.
   *
   * Pairs whose collateral underlying has no buildable Uniswap V3 path back
   * to the debt underlying (and aren't the same token) are skipped — their
   * on-chain liquidation would revert at the swap step.
   *
   * Profit math (oracle prices scaled to 1e36/decimals, USD held in 1e18):
   *   debtUsd_1e18      = debt.amount * priceDebt / 1e18
   *   maxRepayUsd       = debtUsd_1e18 * closeFactor / 1e18
   *   collUnderlying    = cTokenAmount * exchangeRate / 1e18
   *   collateralUsd     = collUnderlying * priceColl / 1e18
   *   collCappedRepay   = collateralUsd * 1e18 / liquidationIncentive
   *   effectiveRepayUsd = min(maxRepayUsd, collCappedRepay)
   *   grossProfitUsd    = effectiveRepayUsd * (liquidationIncentive - 1e18) / 1e18
   *   aavePremium       = effectiveRepayUsd * 5 / 10000   (5 bps)
   *   poolFee           = effectiveRepayUsd * pathFeeBps / 10000
   *   slippage          = effectiveRepayUsd * slippageBps / 10000
   *   netProfitUsd      = grossProfitUsd - aavePremium - poolFee - slippage
   *
   * @param {object} position Position emitted by getLiquidatable().
   * @returns {Promise<{ profitUsd: number, gasCostUsd: number, netUsd: number, swapPath?: string }>}
   */
  async estimateProfit(position) {
    const params = await this._loadProtocolParams();
    const { prices, exchangeRates } = await this._loadPricesAndExchangeRates(position, params.oracle);
    const gasCostUsd1e18 = await this._estimateGasUsd(prices);
    await this._loadTokenMetadata();

    const best = this._bestLiquidationPair(position, params, prices, exchangeRates);
    const grossProfit1e18 = best?.profit1e18 ?? 0n;
    const tradeCosts1e18  = best?.tradeCosts1e18 ?? 0n;
    const net1e18 = grossProfit1e18 - tradeCosts1e18 - gasCostUsd1e18;

    if (best) {
      // Convert effectiveRepayUsd_1e18 back to a raw debt-token amount,
      // capped by the borrower's actual debt. priceDebt is the oracle
      // mantissa (1e36/decimals), so:
      //   rawAmount = repayUsd_1e18 * 1e18 / priceDebt
      const debtPrice = prices.get(best.debt.mToken.toLowerCase());
      const repayAmountRaw = (best.effectiveRepayUsd * WAD) / debtPrice;
      const cappedRepayAmount = repayAmountRaw < best.debt.amount ? repayAmountRaw : best.debt.amount;
      // amountOutMinimum: floor(repayAmount * (1 + premium) * (1 - slippage)).
      // The swap must deliver enough debt-token to repay flash loan + premium,
      // less the same per-venue slippage haircut already baked into the
      // off-chain net check. V3 same-asset short-circuit skips the swap.
      const swapNeeded = best.venue === 'AERO' || best.swapPath !== '0x';
      const amountOutMinimum = swapNeeded
        ? (cappedRepayAmount * (10_000n + FLASH_LOAN_PREMIUM_BPS) * (10_000n - best.slippageBps))
            / (10_000n * 10_000n)
        : 0n;
      position._plan = {
        mTokenBorrow: best.debt.mToken,
        mTokenCollateral: best.collateral.mToken,
        repayAmountRaw: cappedRepayAmount,
        venue: best.venue,
        swapPath: best.swapPath,
        aeroRoutes: best.aeroRoutes,
        amountOutMinimum,
      };
    }

    // ETH price in USD (1e18-scaled) — handed to the monitor so it can
    // convert receipt.gasUsed × effectiveGasPrice into actual USD spent for
    // the PnL ledger without re-fetching.
    const ethPrice = this._wethMToken ? prices.get(this._wethMToken.toLowerCase()) ?? 0n : 0n;

    const result = {
      profitUsd: wadToFloat(grossProfit1e18),
      gasCostUsd: wadToFloat(gasCostUsd1e18),
      netUsd: wadToFloat(net1e18),
      tradeCostsUsd: wadToFloat(tradeCosts1e18),
      ethUsd1e18: ethPrice,
    };
    if (best) {
      result.venue = best.venue;
      if (best.swapPath) result.swapPath = best.swapPath;
    }
    logger.debug('moonwell.estimateProfit', {
      borrower: position.borrower,
      ...result,
      tradeCostsUsd: wadToFloat(tradeCosts1e18),
      pair: best ? { debt: best.debt.symbol, collateral: best.collateral.symbol } : null,
    });
    return result;
  }

  /**
   * Encode a transaction calling `Liquidator.liquidate(...)` with the pair
   * AND swap path chosen by `estimateProfit`. Caller must have already invoked
   * `estimateProfit(position)` so `position._plan` is populated.
   *
   * @param {object} position Position with `_plan` set by estimateProfit().
   * @returns {{ to: `0x${string}`, data: `0x${string}`, value: bigint }}
   */
  buildLiquidationCall(position) {
    if (!position?._plan) {
      throw new Error('MoonwellAdapter.buildLiquidationCall: call estimateProfit(position) first');
    }
    const to = this.liquidatorAddress;
    if (!to) {
      throw new Error('MoonwellAdapter.buildLiquidationCall: liquidatorAddress required');
    }
    const { mTokenBorrow, mTokenCollateral, repayAmountRaw, venue, swapPath, aeroRoutes, amountOutMinimum } = position._plan;
    if (!venue) {
      throw new Error('MoonwellAdapter.buildLiquidationCall: _plan.venue missing — estimateProfit picked an unroutable pair');
    }

    let data;
    if (venue === 'V3') {
      if (!swapPath) {
        throw new Error('MoonwellAdapter.buildLiquidationCall: V3 venue without swapPath');
      }
      data = encodeFunctionData({
        abi: LIQUIDATOR_ABI,
        functionName: 'liquidate',
        args: [position.borrower, mTokenBorrow, mTokenCollateral, repayAmountRaw, swapPath, amountOutMinimum ?? 0n],
      });
    } else if (venue === 'AERO') {
      if (!aeroRoutes?.length) {
        throw new Error('MoonwellAdapter.buildLiquidationCall: AERO venue without aeroRoutes');
      }
      data = encodeFunctionData({
        abi: LIQUIDATOR_ABI,
        functionName: 'liquidateAero',
        args: [position.borrower, mTokenBorrow, mTokenCollateral, repayAmountRaw, aeroRoutes, amountOutMinimum ?? 0n],
      });
    } else {
      throw new Error(`MoonwellAdapter.buildLiquidationCall: unknown venue ${venue}`);
    }

    return { to, data, value: 0n };
  }

  /**
   * Populate `this._tokenMeta` (mToken → underlying + decimals + symbol) by
   * reading on-chain once. Subsequent calls are no-ops; concurrent calls
   * share one in-flight promise.
   *
   * Special-case: Moonwell's mWETH may be a CEther variant whose
   * `underlying()` reverts. We substitute the canonical WETH address; this
   * matches what `Liquidator.sol` does on-chain (it pre-wraps native ETH
   * captured from `redeem` into WETH before swapping; line 156–158).
   */
  async _loadTokenMetadata() {
    if (this._tokenMeta.size > 0) return;
    if (this._tokenMetaPromise) return this._tokenMetaPromise;

    this._tokenMetaPromise = (async () => {
      if (this.tokenCache) {
        const cached = await this.tokenCache.load();
        if (cached.size === this.mTokens.length) {
          this._tokenMeta = cached;
          logger.info('moonwell.tokenMeta cache hit', { count: cached.size });
          return;
        }
      }

      const underlyingResults = await this.client.multicall({
        contracts: this.mTokens.map((m) => ({
          address: m.address,
          abi: MTOKEN_ABI,
          functionName: 'underlying',
        })),
        allowFailure: true,
      });

      // Step 2: decimals() on each successful underlying. mWETH revert →
      // substitute canonical WETH and look up its decimals (18) statically.
      const resolved = this.mTokens.map((m, i) => {
        const r = underlyingResults[i];
        let underlying;
        if (r?.status === 'success' && r.result) {
          underlying = r.result;
        } else if (m.underlying === 'WETH') {
          underlying = TOKENS_BASE.WETH;
        } else {
          underlying = null;
        }
        return { mToken: m.address, symbol: m.symbol, underlying };
      });

      const toQuery = resolved.filter((r) => r.underlying);
      const decimalsResults = await this.client.multicall({
        contracts: toQuery.map((r) => ({
          address: r.underlying,
          abi: ERC20_DECIMALS_ABI,
          functionName: 'decimals',
        })),
        allowFailure: true,
      });

      for (let i = 0; i < toQuery.length; i++) {
        const dr = decimalsResults[i];
        toQuery[i].decimals = dr?.status === 'success' ? Number(dr.result) : null;
      }

      const map = new Map();
      for (const r of resolved) {
        if (!r.underlying || r.decimals == null) {
          logger.warn('moonwell.tokenMeta missing — pair will be skipped', {
            mToken: r.mToken, symbol: r.symbol,
          });
          continue;
        }
        map.set(r.mToken.toLowerCase(), {
          underlying: r.underlying,
          decimals: r.decimals,
          symbol: r.symbol,
        });
      }
      this._tokenMeta = map;

      if (this.tokenCache) {
        try { await this.tokenCache.save(map); }
        catch (err) { logger.warn('moonwell.tokenMeta save failed', { error: err.message }); }
      }
      logger.info('moonwell.tokenMeta loaded', { count: map.size });
    })();

    try { await this._tokenMetaPromise; }
    finally { this._tokenMetaPromise = null; }
  }

  async _loadProtocolParams() {
    const [closeFactor, liquidationIncentive, oracle] = await this.client.multicall({
      contracts: [
        { address: this.comptroller, abi: COMPTROLLER_ABI, functionName: 'closeFactorMantissa' },
        { address: this.comptroller, abi: COMPTROLLER_ABI, functionName: 'liquidationIncentiveMantissa' },
        { address: this.comptroller, abi: COMPTROLLER_ABI, functionName: 'oracle' },
      ],
      allowFailure: false,
    });
    return { closeFactor, liquidationIncentive, oracle };
  }

  async _loadPricesAndExchangeRates(position, oracleAddr) {
    const priceTargets = new Set([
      ...position.debts.map((d) => d.mToken.toLowerCase()),
      ...position.collaterals.map((c) => c.mToken.toLowerCase()),
    ]);
    if (this._wethMToken) priceTargets.add(this._wethMToken.toLowerCase());

    const priceList = [...priceTargets];
    const collList = position.collaterals.map((c) => c.mToken);

    if (priceList.length === 0 && collList.length === 0) {
      return { prices: new Map(), exchangeRates: new Map() };
    }

    const calls = [
      ...priceList.map((mt) => ({
        address: oracleAddr,
        abi: PRICE_ORACLE_ABI,
        functionName: 'getUnderlyingPrice',
        args: [mt],
      })),
      ...collList.map((mt) => ({
        address: mt,
        abi: MTOKEN_ABI,
        functionName: 'exchangeRateStored',
      })),
    ];
    const results = await this.client.multicall({ contracts: calls, allowFailure: true });

    const prices = new Map();
    for (let i = 0; i < priceList.length; i++) {
      const r = results[i];
      if (r?.status === 'success') prices.set(priceList[i], r.result);
    }
    const exchangeRates = new Map();
    for (let j = 0; j < collList.length; j++) {
      const r = results[priceList.length + j];
      if (r?.status === 'success') exchangeRates.set(collList[j].toLowerCase(), r.result);
    }
    return { prices, exchangeRates };
  }

  async _estimateGasUsd(prices) {
    if (!this._wethMToken) return 0n;
    const ethPrice = prices.get(this._wethMToken.toLowerCase());
    if (!ethPrice) return 0n;
    const gasPriceWei = await this.client.getGasPrice();
    const gasCostWei = gasPriceWei * this.gasEstimate;
    return (gasCostWei * ethPrice) / WAD;
  }

  _bestLiquidationPair(position, params, prices, exchangeRates) {
    if (params.liquidationIncentive <= WAD) return null;
    const bonusBps = params.liquidationIncentive - WAD;
    const BPS_DENOM = 10_000n;

    let best = null;
    let bestNet1e18 = null;
    for (const debt of position.debts) {
      const debtPrice = prices.get(debt.mToken.toLowerCase());
      if (!debtPrice) {
        this._recordSkip(position.borrower, 'no debt oracle price', debt.symbol);
        continue;
      }
      const debtMeta = this._tokenMeta.get(debt.mToken.toLowerCase());
      if (!debtMeta) {
        this._recordSkip(position.borrower, 'no debt token metadata', debt.symbol);
        continue;
      }
      const debtUsd = (debt.amount * debtPrice) / WAD;
      const maxRepayUsd = (debtUsd * params.closeFactor) / WAD;
      if (maxRepayUsd === 0n) continue;

      for (const coll of position.collaterals) {
        const collPrice = prices.get(coll.mToken.toLowerCase());
        const exchangeRate = exchangeRates.get(coll.mToken.toLowerCase());
        if (!collPrice || !exchangeRate) {
          this._recordSkip(position.borrower, 'no collateral oracle/exchangeRate', debt.symbol, coll.symbol);
          continue;
        }
        const collMeta = this._tokenMeta.get(coll.mToken.toLowerCase());
        if (!collMeta) {
          this._recordSkip(position.borrower, 'no collateral token metadata', debt.symbol, coll.symbol);
          continue;
        }

        // Pick a venue (V3 first, Aerodrome fallback). null → no buildable
        // route on either; on-chain swap would revert.
        const venuePick = pickSwapVenue(collMeta.underlying, debtMeta.underlying);
        if (venuePick === null) {
          this._recordSkip(position.borrower, 'no swap route (V3 or AERO)', debt.symbol, coll.symbol);
          continue;
        }

        const collUnderlying = (coll.cTokenAmount * exchangeRate) / WAD;
        const collateralUsd = (collUnderlying * collPrice) / WAD;
        if (collateralUsd === 0n) continue;

        const collCappedRepayUsd = (collateralUsd * WAD) / params.liquidationIncentive;
        const effectiveRepayUsd = maxRepayUsd < collCappedRepayUsd ? maxRepayUsd : collCappedRepayUsd;

        const profit1e18 = (effectiveRepayUsd * bonusBps) / WAD;
        const aavePremium = (effectiveRepayUsd * FLASH_LOAN_PREMIUM_BPS) / BPS_DENOM;
        // Venue-specific haircut: V3 splits fee+slippage; Aerodrome bundles
        // them into a single 100 bps bucket (pool depth varies too much for
        // a precise per-pair fee table to be honest).
        let poolFeeBps;
        let slippageBps;
        if (venuePick.venue === 'V3') {
          poolFeeBps = pathFeeBps(collMeta.underlying, debtMeta.underlying);
          slippageBps = SLIPPAGE_BPS_BY_TOKEN(collMeta.underlying, debtMeta.underlying);
        } else {
          poolFeeBps = 0n;
          slippageBps = AERO_HAIRCUT_BPS;
        }
        const poolFee = (effectiveRepayUsd * poolFeeBps) / BPS_DENOM;
        const slippage = (effectiveRepayUsd * slippageBps) / BPS_DENOM;
        const tradeCosts1e18 = aavePremium + poolFee + slippage;
        const net1e18 = profit1e18 - tradeCosts1e18;

        if (best === null || net1e18 > bestNet1e18) {
          best = {
            debt,
            collateral: coll,
            profit1e18,
            effectiveRepayUsd,
            tradeCosts1e18,
            venue: venuePick.venue,
            swapPath: venuePick.swapPath ?? null,
            aeroRoutes: venuePick.aeroRoutes ?? null,
            slippageBps,
          };
          bestNet1e18 = net1e18;
        }
      }
    }
    return best;
  }
}

function wadToFloat(wad) {
  // bigint → float USD. Precision degrades above ~9e7 USD; fine for single
  // liquidations.
  const sign = wad < 0n ? -1 : 1;
  const abs = wad < 0n ? -wad : wad;
  const whole = Number(abs / WAD);
  const frac = Number(abs % WAD) / 1e18;
  return sign * (whole + frac);
}
