/**
 * Aave v3 on Base mainnet — addresses we use for `flashLoanSimple`.
 *
 * Pool source: Aave v3 deployments registry,
 *   https://aave.com/docs/resources/addresses
 * The Pool exposes `flashLoanSimple(receiver, asset, amount, params, referralCode)`
 * and `FLASHLOAN_PREMIUM_TOTAL()` (in bps). On Base the standard 0.05% fee applies.
 *
 * The receiver contract must implement `IFlashLoanSimpleReceiver.executeOperation`
 * and approve the Pool to pull `amount + premium` of `asset` before returning.
 */

export const AAVE_BASE = {
  pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
};

// Aave v3 flashLoanSimple premium on Base, in basis points of the borrowed
// amount. Read once and hard-coded — the value is governance-controlled and
// has been 5 bps since v3 launch. If Aave changes it, profit math will under-
// or over-estimate by the delta until this constant is updated.
//
// Authoritative source: `Pool.FLASHLOAN_PREMIUM_TOTAL()` (returns 5 = 0.05%).
export const FLASH_LOAN_PREMIUM_BPS = 5n;
