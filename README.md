# Liquidation bot

A liquidation bot for lending markets on Base mainnet, with a Solidity executor that pays for itself via an Aave v3 flash loan. The first (and only) target adapter is Moonwell — a Compound v2 fork — but the engine is protocol-agnostic behind a small JS interface.

The on-chain executor is deployed and verified at [`0xfc6678D9F62DA7875dc1ABE11D2A86C1e59C4617`](https://basescan.org/address/0xfc6678D9F62DA7875dc1ABE11D2A86C1e59C4617#code).

## Why a bot, why this design

Liquidations on Compound-v2-style markets pay a fixed bonus (~8% of the seized collateral) to whoever calls `liquidateBorrow` on an unhealthy position. The hard parts are: finding the unhealthy positions before everyone else, paying for the debt repayment without putting up your own capital, and getting the seized collateral back to the debt asset cheaply enough that net-of-gas is positive.

The bot solves those three:

1. **Indexer** — scans `Borrow` events forward from a known start block, caches every borrower address, and re-checks the cache against `Comptroller.getAccountLiquidity` on a sharded schedule. A position with `shortfall > 0` is liquidatable.
2. **Profit estimator** — for each candidate, prices the seized collateral against the debt repayment using Moonwell's price oracle, computes flash-loan premium + V3/Aerodrome swap cost + gas, and rejects anything below `MIN_PROFIT_USD`.
3. **Executor** — a single Solidity contract that pulls the debt asset from Aave via `flashLoanSimple`, calls `liquidateBorrow`, redeems the seized cTokens, swaps back to the debt asset (Uniswap V3 by default, Aerodrome for long-tail tokens with no V3 path), and sweeps the surplus to `owner()`. Same-asset positions skip the swap.

The executor is the only contract; everything else is JS.

## Architecture

```
                                +--------------------+
                                |   PositionMonitor  |  protocol-agnostic loop
                                +---------+----------+
                                          |
                            +-------------+-------------+
                            |                           |
                  IProtocolAdapter            Executor (viem WalletClient)
                            |                           |
                  +---------+---------+                 |
                  |                   |                 v
            MoonwellAdapter      (Morpho Blue,    Liquidator.sol on Base
            (built)               not built)     (Aave v3 flash loan +
                                                  liquidateBorrow + redeem
                                                  + V3/Aerodrome swap)
```

Every adapter implements four methods:

| Method | Returns | Job |
|---|---|---|
| `indexBorrowers()` | void | Discover all open borrower positions, cache them. |
| `getLiquidatable()` | `Position[]` | Return the subset currently eligible for liquidation. |
| `estimateProfit(p)` | `{ profitUsd, gasCostUsd, netUsd, ... }` | Project net profit after gas + slippage. |
| `buildLiquidationCall(p)` | `{ to, data, value }` | Build the calldata. Pure — no RPC. |

The core loop never inspects a `Position` past what it hands back to the adapter, so adapters are free to keep whatever state they want.

## What's in the repo

- `contracts/Liquidator.sol` — Aave v3 flash-loan executor. Two entry points (`liquidate` for V3, `liquidateAero` for Aerodrome routes), owner-gated, with `amountOutMinimum` enforced on every swap so a thin or sandwiched pool reverts before the flash-loan premium is paid.
- `core/PositionMonitor.js` — protocol-agnostic loop. Index once, tick on every new block (or fall back to interval polling), bounded-concurrency profit evaluation so the free-tier RPC doesn't get rate-limited.
- `core/Executor.js` — viem wallet wrapper. Pre-flights against `MAX_GAS_PRICE_GWEI` (no tx if over), uses `estimateGas` with a static fallback, returns receipts cleanly typed.
- `core/PnlLedger.js` — append-only JSONL ledger of every attempt: estimated vs actual profit, gas, status. `npm run pnl` summarises.
- `adapters/MoonwellAdapter.js` — borrower indexing via `Borrow` events, eligibility via `Comptroller.getAccountLiquidity`, profit via the price oracle + a route finder that walks both Uniswap V3 and Aerodrome.
- `utils/notifier.js` — Discord webhook client. Levels map to embed colors. Never throws — webhook outages must not break the loop.
- `utils/rpcRotator.js` — sticky-failover transport. Only used for the historical `eth_getLogs` borrower scan, where free Alchemy plans cap at 10 blocks per call. Falls over to `mainnet.base.org` / `publicnode` / `llamarpc` on 429/5xx.
- `contracts/test/Liquidator.t.sol` — Foundry fork test against a pinned Base block. No mocks. Forks via `ALCHEMY_HTTP_URL` and runs the full liquidation against real Moonwell + Aave + Uniswap state.
- `src/test/*.test.js` — Vitest unit tests (86, all passing).

## Design choices worth calling out

**Bigint everywhere on-chain quantities.** `Number` is only used at the user-facing boundary (USD thresholds, log lines). Mixing the two on token amounts is the fastest way to silently lose money to floating-point.

**Addresses live in `config/`, never inline.** Every Comptroller, mToken, oracle, router, and Aave Pool address is imported from a central module. Makes a chain swap or fork-block bump a one-line change instead of a grep-and-replace.

**`viem` for everything; ethers nowhere.** ESM-native, type-friendly, and the multicall + block-watch ergonomics are noticeably better.

**Sharded eligibility checks.** Naively re-checking 1300+ borrowers every tick blows the RPC budget. Borrowers are split into N shards (default 4); each tick scans one shard, with a full-cache scan every K ticks. So every borrower is re-checked roughly once a minute at 2-second block cadence, but per-tick RPC load drops 4×.

**Bounded-concurrency profit estimation.** Each candidate fires an `eth_gasPrice` plus a fat `aggregate3` multicall. Unbounded `Promise.all` over 80+ candidates instantly blows free-tier compute units. `MONITOR_CONCURRENCY` (default 4) caps it.

**Same-asset short-circuit.** When debt and collateral are the same token (e.g. you can liquidate a USDC borrow with USDC collateral), the executor skips the swap entirely — `swapPath = "0x"`, `amountOutMinimum = 0`. Cheaper, no slippage, and competitive on small positions other bots ignore.

**Aerodrome fallback for long-tail tokens.** Some Base collateral (VVV, MAMO, MORPHO) has no buildable Uniswap V3 path back to USDC/WETH. Rather than skip those candidates, the executor has a second entry point (`liquidateAero`) that routes through Aerodrome's Solidly-fork pools. The adapter picks the venue per-candidate.

## What's not built

- **Morpho Blue adapter.** The interface is in place and there are notes on the share→asset conversion (Morpho stores balances in shares, not assets, and you have to multiply through the market totals before comparing to the LLTV). The adapter itself is not written.
- **Mempool subscription / MEV protection.** The bot runs against the public mempool with no Flashbots-equivalent on Base. In a competitive environment this matters; in practice on Base it's been less of an issue than the RPC budget.
- **Retry/backoff on transient RPC errors.** A 429 on `estimateProfit` drops the candidate for that tick; the next tick (1–12 s later) retries.

## Run it

```bash
cp .env.example .env       # fill in the keys — see below
npm install
forge install              # idempotent; pulls forge-std, OZ, solmate
forge build
npm test                   # 86 vitest unit tests
npm run test:fork          # foundry fork test against Base
npm start                  # live monitor
DRY_RUN=true npm start     # dry-run: same code path, no broadcast
```

A typical first run: drop `MIN_PROFIT_USD` to something small (1–2), `DRY_RUN=true npm start`, watch the log for `Candidate:` lines and the Discord channel for embeds. When something looks plausible, unset `DRY_RUN` and run live.

### `.env` values

| Var | Required | Default | Notes |
|---|---|---|---|
| `ALCHEMY_HTTP_URL` | yes | — | Base mainnet HTTPS RPC. Used for everything except historical log scans. |
| `ALCHEMY_WS_URL` | no | — | Optional WebSocket. If set, ticks fire on every new block; otherwise the bot polls. |
| `PRIVATE_KEY` | yes | — | Use a dedicated hot wallet. Don't reuse anything that touches CEX or LP positions. |
| `LIQUIDATOR_ADDRESS` | yes after deploy | — | Address of the deployed `Liquidator.sol`. `npm run deploy:liquidator` writes it. |
| `DISCORD_WEBHOOK_URL` | no | — | If unset, alerts are no-ops. The loop never depends on Discord being up. |
| `BASESCAN_API_KEY` | no (verify only) | — | Only needed for `forge verify`. |
| `MIN_PROFIT_USD` | no | `0.5` | Skip candidates whose net (after gas + premium + swap) is below this. |
| `MAX_GAS_PRICE_GWEI` | no | `50` | Refuse to broadcast above this gas price. Bot logs a warn embed and skips. |
| `MONITOR_CONCURRENCY` | no | `4` | Max parallel `estimateProfit` calls. Lower if you see 429s; raise on a paid RPC. |
| `POLL_INTERVAL_MS` | no | `12000` | Fallback poll cadence when `ALCHEMY_WS_URL` is unset. |
| `DRY_RUN` | no | `false` | Goes through the whole pipeline including `estimateGas`, but doesn't broadcast. |

## Honest framing

This bot is feature-complete and shipped, but it never won a competitive liquidation in production. Base's mainstream pairs (USDC/WETH/cbETH/cbBTC) are saturated by hunters running paid RPC tiers, private mempools, and dedicated infra; this is a single-VPS bot on free Alchemy. The headroom is in the long-tail Aerodrome-only pairs and the same-asset short-circuit, which is why those code paths exist. Treat this as a portfolio of working DeFi engineering, not a profitable strategy.

## License

MIT.
