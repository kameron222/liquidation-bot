/**
 * Morpho Blue singleton ABI — the subset the adapter and executor touch.
 *
 * Morpho Blue is a single, immutable contract holding every isolated market.
 * A market is keyed by `Id = keccak256(abi.encode(MarketParams))`; storage is
 * read with `market(Id)` (aggregate totals) and `position(Id, user)`
 * (per-account shares + collateral).
 *
 * Balances are stored in *shares*, not assets. To compare a borrower's debt
 * against the LLTV you must convert borrowShares → assets through the market
 * totals (see MorphoBlueAdapter._borrowAssets), which is why the raw getters
 * below return the totals alongside the per-account shares.
 *
 * Source: morpho-org/morpho-blue `src/Morpho.sol` + `src/interfaces/IMorpho.sol`.
 */

// The MarketParams tuple, reused by every market-scoped call.
export const MARKET_PARAMS_TUPLE = {
  type: 'tuple',
  name: 'marketParams',
  components: [
    { name: 'loanToken',       type: 'address' },
    { name: 'collateralToken', type: 'address' },
    { name: 'oracle',          type: 'address' },
    { name: 'irm',             type: 'address' },
    { name: 'lltv',            type: 'uint256' },
  ],
};

// The Market storage struct, needed as an argument to IRM.borrowRateView.
export const MARKET_TUPLE = {
  type: 'tuple',
  name: 'market',
  components: [
    { name: 'totalSupplyAssets', type: 'uint128' },
    { name: 'totalSupplyShares', type: 'uint128' },
    { name: 'totalBorrowAssets', type: 'uint128' },
    { name: 'totalBorrowShares', type: 'uint128' },
    { name: 'lastUpdate',        type: 'uint128' },
    { name: 'fee',               type: 'uint128' },
  ],
};

export const MORPHO_ABI = [
  {
    type: 'function',
    name: 'market',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'totalSupplyAssets', type: 'uint128' },
      { name: 'totalSupplyShares', type: 'uint128' },
      { name: 'totalBorrowAssets', type: 'uint128' },
      { name: 'totalBorrowShares', type: 'uint128' },
      { name: 'lastUpdate',        type: 'uint128' },
      { name: 'fee',               type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'position',
    stateMutability: 'view',
    inputs: [
      { name: 'id',   type: 'bytes32' },
      { name: 'user', type: 'address' },
    ],
    outputs: [
      { name: 'supplyShares', type: 'uint256' },
      { name: 'borrowShares', type: 'uint128' },
      { name: 'collateral',   type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'idToMarketParams',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'loanToken',       type: 'address' },
      { name: 'collateralToken', type: 'address' },
      { name: 'oracle',          type: 'address' },
      { name: 'irm',             type: 'address' },
      { name: 'lltv',            type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'liquidate',
    stateMutability: 'nonpayable',
    inputs: [
      MARKET_PARAMS_TUPLE,
      { name: 'borrower',     type: 'address' },
      { name: 'seizedAssets', type: 'uint256' },
      { name: 'repaidShares', type: 'uint256' },
      { name: 'data',         type: 'bytes'   },
    ],
    outputs: [
      { name: '', type: 'uint256' },
      { name: '', type: 'uint256' },
    ],
  },
];

// Borrow(Id indexed id, address caller, address indexed onBehalf,
//        address indexed receiver, uint256 assets, uint256 shares)
// `onBehalf` is the borrower we cache; `id` lets us filter logs per market.
export const MORPHO_BORROW_EVENT = {
  type: 'event',
  name: 'Borrow',
  inputs: [
    { name: 'id',       type: 'bytes32', indexed: true  },
    { name: 'caller',   type: 'address', indexed: false },
    { name: 'onBehalf', type: 'address', indexed: true  },
    { name: 'receiver', type: 'address', indexed: true  },
    { name: 'assets',   type: 'uint256', indexed: false },
    { name: 'shares',   type: 'uint256', indexed: false },
  ],
};

// Morpho market oracle: price of 1 unit of collateral quoted in loan-token,
// scaled by 1e36 * 10^(loanDecimals - collateralDecimals). Consumers divide
// by ORACLE_PRICE_SCALE (1e36) after multiplying by the collateral amount.
export const MORPHO_ORACLE_ABI = [{
  type: 'function',
  name: 'price',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
}];

// Adaptive Curve IRM. `borrowRateView` is the view variant used to project
// accrued interest off-chain without mutating state.
export const MORPHO_IRM_ABI = [{
  type: 'function',
  name: 'borrowRateView',
  stateMutability: 'view',
  inputs: [MARKET_PARAMS_TUPLE, MARKET_TUPLE],
  outputs: [{ name: '', type: 'uint256' }],
}];
