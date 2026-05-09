// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * Liquidator — Aave v3 flash-loan executor for Compound v2 / Moonwell.
 *
 * Two entry points, dispatched on a `venue` tag inside the flash-loan params:
 *   - `liquidate(... swapPath, amountOutMinimum)` for Uniswap V3 routes.
 *   - `liquidateAero(... aeroRoutes, amountOutMinimum)` for Aerodrome
 *     (Solidly fork) routes — used for long-tail Base tokens that have no
 *     buildable V3 path back to the borrow asset.
 *
 * Flow (both venues):
 *   1. Pull `repayAmount` of the underlying borrow asset from the Aave Pool via
 *      `flashLoanSimple`.
 *   2. In the `executeOperation` callback:
 *      a. Approve `mTokenBorrow` to pull the borrow asset, then call
 *         `liquidateBorrow(borrower, repayAmount, mTokenCollateral)`.
 *      b. Redeem the seized cTokens for the underlying collateral via
 *         `mTokenCollateral.redeem(balanceOf(this))`. mWETH redeems pay native
 *         ETH; we wrap before swapping.
 *      c. Swap the collateral underlying back into the borrow asset via the
 *         venue indicated by the flash-loan params, enforcing
 *         `amountOutMinimum` so a thin or sandwiched pool reverts before we
 *         waste the flash-loan premium.
 *      d. Approve the Aave Pool to pull `amount + premium`.
 *   3. Sweep any leftover borrow asset to `owner()`.
 *
 * Only `owner()` can invoke either entry point. Only the Aave Pool can invoke
 * `executeOperation`. Stranded balances can be recovered via `sweep`.
 *
 * For V3 with same-asset (no swap needed), pass `swapPath = "0x"` and
 * `amountOutMinimum = 0`. For Aerodrome there is no same-asset short-circuit
 * — same-asset positions go through V3.
 */

interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IFlashLoanSimpleReceiver {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool);
}

interface ICToken {
    function liquidateBorrow(address borrower, uint256 repayAmount, address cTokenCollateral) external returns (uint256);

    function redeem(uint256 redeemTokens) external returns (uint256);

    function balanceOf(address owner) external view returns (uint256);

    function underlying() external view returns (address);
}

interface IV3SwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

// Solidly-fork (Aerodrome) router. `factory == address(0)` instructs the
// router to use its `defaultFactory`.
struct AeroRoute {
    address from;
    address to;
    bool stable;
    address factory;
}

interface IAerodromeRouter {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        AeroRoute[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

contract Liquidator is Ownable, IFlashLoanSimpleReceiver {
    using SafeERC20 for IERC20;

    error NotPool();
    error NotInitiator();
    error CompoundError(uint256 code);
    error EmptySeizure();
    error UnknownVenue(uint8 venue);

    uint8 internal constant VENUE_V3 = 0;
    uint8 internal constant VENUE_AERO = 1;

    IPool public immutable POOL;
    IV3SwapRouter public immutable SWAP_ROUTER;
    IAerodromeRouter public immutable AERO_ROUTER;
    IWETH9 public immutable WETH;

    constructor(address pool, address swapRouter, address aeroRouter, address weth, address initialOwner)
        Ownable(initialOwner)
    {
        POOL = IPool(pool);
        SWAP_ROUTER = IV3SwapRouter(swapRouter);
        AERO_ROUTER = IAerodromeRouter(aeroRouter);
        WETH = IWETH9(weth);
    }

    /**
     * Uniswap V3 entry point. `swapPath` is the packed V3 multi-hop encoding;
     * `swapPath = "0x"` skips the swap entirely (same-asset case).
     */
    function liquidate(
        address borrower,
        address mTokenBorrow,
        address mTokenCollateral,
        uint256 repayAmount,
        bytes calldata swapPath,
        uint256 amountOutMinimum
    ) external onlyOwner {
        address borrowAsset = ICToken(mTokenBorrow).underlying();
        bytes memory inner = abi.encode(borrower, mTokenBorrow, mTokenCollateral, swapPath, amountOutMinimum);
        bytes memory params = abi.encode(VENUE_V3, inner);
        POOL.flashLoanSimple(address(this), borrowAsset, repayAmount, params, 0);
    }

    /**
     * Aerodrome (Solidly fork) entry point. Used for long-tail collateral
     * tokens that have no buildable Uniswap V3 path to the debt asset.
     */
    function liquidateAero(
        address borrower,
        address mTokenBorrow,
        address mTokenCollateral,
        uint256 repayAmount,
        AeroRoute[] calldata aeroRoutes,
        uint256 amountOutMinimum
    ) external onlyOwner {
        address borrowAsset = ICToken(mTokenBorrow).underlying();
        bytes memory inner = abi.encode(borrower, mTokenBorrow, mTokenCollateral, aeroRoutes, amountOutMinimum);
        bytes memory params = abi.encode(VENUE_AERO, inner);
        POOL.flashLoanSimple(address(this), borrowAsset, repayAmount, params, 0);
    }

    /**
     * Aave callback. Decodes the venue tag, runs the protocol-side liquidation
     * + redeem, then dispatches the swap to the right venue.
     */
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        override
        returns (bool)
    {
        if (msg.sender != address(POOL)) revert NotPool();
        if (initiator != address(this)) revert NotInitiator();

        (uint8 venue, bytes memory inner) = abi.decode(params, (uint8, bytes));

        if (venue == VENUE_V3) {
            _executeV3(asset, amount, inner);
        } else if (venue == VENUE_AERO) {
            _executeAero(asset, amount, inner);
        } else {
            revert UnknownVenue(venue);
        }

        uint256 owed = amount + premium;
        IERC20(asset).forceApprove(address(POOL), owed);

        uint256 bal = IERC20(asset).balanceOf(address(this));
        if (bal > owed) {
            IERC20(asset).safeTransfer(owner(), bal - owed);
        }

        return true;
    }

    function _executeV3(address asset, uint256 amount, bytes memory inner) internal {
        (
            address borrower,
            address mTokenBorrow,
            address mTokenCollateral,
            bytes memory swapPath,
            uint256 amountOutMinimum
        ) = abi.decode(inner, (address, address, address, bytes, uint256));

        _liquidateAndRedeem(asset, amount, borrower, mTokenBorrow, mTokenCollateral);

        if (swapPath.length > 0) {
            address collUnderlying = ICToken(mTokenCollateral).underlying();
            _wrapNativeIfWeth(collUnderlying);
            uint256 collBal = IERC20(collUnderlying).balanceOf(address(this));
            IERC20(collUnderlying).forceApprove(address(SWAP_ROUTER), collBal);
            SWAP_ROUTER.exactInput(
                IV3SwapRouter.ExactInputParams({
                    path: swapPath, recipient: address(this), amountIn: collBal, amountOutMinimum: amountOutMinimum
                })
            );
            IERC20(collUnderlying).forceApprove(address(SWAP_ROUTER), 0);
        }
    }

    function _executeAero(address asset, uint256 amount, bytes memory inner) internal {
        (
            address borrower,
            address mTokenBorrow,
            address mTokenCollateral,
            AeroRoute[] memory aeroRoutes,
            uint256 amountOutMinimum
        ) = abi.decode(inner, (address, address, address, AeroRoute[], uint256));

        _liquidateAndRedeem(asset, amount, borrower, mTokenBorrow, mTokenCollateral);

        address collUnderlying = ICToken(mTokenCollateral).underlying();
        _wrapNativeIfWeth(collUnderlying);
        uint256 collBal = IERC20(collUnderlying).balanceOf(address(this));
        IERC20(collUnderlying).forceApprove(address(AERO_ROUTER), collBal);
        AERO_ROUTER.swapExactTokensForTokens(collBal, amountOutMinimum, aeroRoutes, address(this), block.timestamp);
        IERC20(collUnderlying).forceApprove(address(AERO_ROUTER), 0);
    }

    function _liquidateAndRedeem(
        address asset,
        uint256 amount,
        address borrower,
        address mTokenBorrow,
        address mTokenCollateral
    ) internal {
        IERC20(asset).forceApprove(mTokenBorrow, amount);
        uint256 code = ICToken(mTokenBorrow).liquidateBorrow(borrower, amount, mTokenCollateral);
        if (code != 0) revert CompoundError(code);
        IERC20(asset).forceApprove(mTokenBorrow, 0);

        uint256 seized = ICToken(mTokenCollateral).balanceOf(address(this));
        if (seized == 0) revert EmptySeizure();
        uint256 redeemCode = ICToken(mTokenCollateral).redeem(seized);
        if (redeemCode != 0) revert CompoundError(redeemCode);
    }

    function _wrapNativeIfWeth(address collUnderlying) internal {
        if (collUnderlying == address(WETH) && address(this).balance > 0) {
            WETH.deposit{value: address(this).balance}();
        }
    }

    /**
     * Owner-only rescue for stranded balances (collateral dust, airdrops, etc).
     */
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    receive() external payable {}
}
