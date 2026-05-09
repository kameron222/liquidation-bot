/**
 * IProtocolAdapter — interface contract every protocol adapter must satisfy.
 *
 * The core engine (core/PositionMonitor) is protocol-agnostic and consumes only
 * the four methods below. A `Position` is opaque to the core; each adapter owns
 * its own shape and interprets it back inside buildLiquidationCall /
 * estimateProfit.
 *
 * Concrete adapters MUST extend this class and override every method.
 * Calling a method that hasn't been overridden throws synchronously (or
 * rejects, for async methods) so misconfiguration fails loudly at startup
 * rather than silently no-oping at runtime.
 */
export class IProtocolAdapter {
  /**
   * Discover all open borrower positions for the protocol and update the
   * adapter's internal cache. Typically scans `Borrow` events from a known
   * deploy block forward. Should be idempotent — re-running adds new
   * borrowers without dropping existing ones.
   *
   * @returns {Promise<unknown>}
   */
  async indexBorrowers() {
    throw new Error('IProtocolAdapter.indexBorrowers() must be implemented by the subclass');
  }

  /**
   * Return the subset of cached positions that are currently eligible for
   * liquidation, according to the protocol's own solvency rules.
   *
   * @returns {Promise<Array<object>>} Array of opaque position objects.
   */
  async getLiquidatable() {
    throw new Error('IProtocolAdapter.getLiquidatable() must be implemented by the subclass');
  }

  /**
   * Build the calldata + target for a liquidation transaction. Pure function:
   * MUST NOT make RPC calls. Returned object is consumed verbatim by the
   * executor.
   *
   * @param {object} position Opaque position object produced by this adapter.
   * @returns {{ to: `0x${string}`, data: `0x${string}`, value: bigint }}
   */
  buildLiquidationCall(position) {
    throw new Error('IProtocolAdapter.buildLiquidationCall() must be implemented by the subclass');
  }

  /**
   * Project expected USD profit for liquidating `position`, net of gas and
   * slippage. Used by the core engine to filter against MIN_PROFIT_USD.
   *
   * @param {object} position
   * @returns {Promise<{ profitUsd: number, gasCostUsd: number, netUsd: number }>}
   */
  async estimateProfit(position) {
    throw new Error('IProtocolAdapter.estimateProfit() must be implemented by the subclass');
  }
}
