// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * MorphoLiquidator — self-funding liquidator for Morpho Blue.
 *
 * Unlike the Compound/Moonwell path, no Aave flash loan is needed: Morpho's
 * `liquidate` transfers the seized collateral to the liquidator and then, if
 * `data` is non-empty, invokes `onMorphoLiquidate` *before* pulling the repaid
 * loan tokens. We use that window to swap the seized collateral into the loan
 * token, so the repay is funded entirely by the collateral itself — the only
 * costs are the swap and gas.
 *
 * Two entry points, dispatched on a `venue` tag inside the callback data:
 *   - `liquidate(... swapPath, amountOutMinimum)` for Uniswap V3 routes.
 *   - `liquidateAero(... aeroRoutes, amountOutMinimum)` for Aerodrome
 *     (Solidly fork) routes — long-tail collateral with no buildable V3 path.
 *
 * Flow (both venues):
 *   1. `owner` calls an entry point with the market params, borrower, the exact
 *      `seizedAssets` of collateral to take, and the swap route.
 *   2. We call `MORPHO.liquidate(params, borrower, seizedAssets, 0, data)`.
 *   3. In `onMorphoLiquidate(repaidAssets, data)`:
 *      a. Swap the seized collateral into the loan token, enforcing
 *         `amountOutMinimum` so a thin/sandwiched pool reverts before we owe.
 *      b. Approve Morpho to pull `repaidAssets` of the loan token.
 *   4. Back in the entry point, sweep the loan-token surplus to `owner`.
 *
 * Only `owner` can invoke either entry point. Only Morpho can invoke
 * `onMorphoLiquidate`. Stranded balances are recoverable via `sweep`.
 */

struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

interface IMorpho {
    function liquidate(
        MarketParams calldata marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes calldata data
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid);
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

// Solidly-fork (Aerodrome) router. `factory == address(0)` → router default.
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

contract MorphoLiquidator is Ownable {
    using SafeERC20 for IERC20;

    error NotMorpho();
    error UnknownVenue(uint8 venue);

    uint8 internal constant VENUE_V3 = 0;
    uint8 internal constant VENUE_AERO = 1;

    IMorpho public immutable MORPHO;
    IV3SwapRouter public immutable SWAP_ROUTER;
    IAerodromeRouter public immutable AERO_ROUTER;

    constructor(address morpho, address swapRouter, address aeroRouter, address initialOwner) Ownable(initialOwner) {
        MORPHO = IMorpho(morpho);
        SWAP_ROUTER = IV3SwapRouter(swapRouter);
        AERO_ROUTER = IAerodromeRouter(aeroRouter);
    }

    /**
     * Uniswap V3 entry point. `swapPath` is the packed V3 multi-hop encoding
     * (collateralToken → … → loanToken); `swapPath = "0x"` skips the swap for
     * the degenerate loan==collateral case.
     */
    function liquidate(
        MarketParams calldata marketParams,
        address borrower,
        uint256 seizedAssets,
        bytes calldata swapPath,
        uint256 amountOutMinimum
    ) external onlyOwner {
        bytes memory inner = abi.encode(
            marketParams.collateralToken, marketParams.loanToken, swapPath, amountOutMinimum
        );
        bytes memory data = abi.encode(VENUE_V3, inner);
        MORPHO.liquidate(marketParams, borrower, seizedAssets, 0, data);
        _sweep(marketParams.loanToken);
    }

    /**
     * Aerodrome entry point for long-tail collateral without a V3 path.
     */
    function liquidateAero(
        MarketParams calldata marketParams,
        address borrower,
        uint256 seizedAssets,
        AeroRoute[] calldata aeroRoutes,
        uint256 amountOutMinimum
    ) external onlyOwner {
        bytes memory inner = abi.encode(
            marketParams.collateralToken, marketParams.loanToken, aeroRoutes, amountOutMinimum
        );
        bytes memory data = abi.encode(VENUE_AERO, inner);
        MORPHO.liquidate(marketParams, borrower, seizedAssets, 0, data);
        _sweep(marketParams.loanToken);
    }

    /**
     * Morpho callback. Swaps the seized collateral into the loan token, then
     * approves Morpho to pull `repaidAssets`.
     */
    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external {
        if (msg.sender != address(MORPHO)) revert NotMorpho();

        (uint8 venue, bytes memory inner) = abi.decode(data, (uint8, bytes));

        if (venue == VENUE_V3) {
            _swapV3(inner);
        } else if (venue == VENUE_AERO) {
            _swapAero(inner);
        } else {
            revert UnknownVenue(venue);
        }

        // Fund the repay. Morpho pulls exactly `repaidAssets` after this returns.
        (, address loanToken,,) = _decodeCommon(inner);
        IERC20(loanToken).forceApprove(address(MORPHO), repaidAssets);
    }

    function _swapV3(bytes memory inner) internal {
        (address collateralToken, address loanToken, bytes memory swapPath, uint256 amountOutMinimum) =
            abi.decode(inner, (address, address, bytes, uint256));
        if (swapPath.length == 0 || collateralToken == loanToken) return;

        uint256 collBal = IERC20(collateralToken).balanceOf(address(this));
        IERC20(collateralToken).forceApprove(address(SWAP_ROUTER), collBal);
        SWAP_ROUTER.exactInput(
            IV3SwapRouter.ExactInputParams({
                path: swapPath, recipient: address(this), amountIn: collBal, amountOutMinimum: amountOutMinimum
            })
        );
        IERC20(collateralToken).forceApprove(address(SWAP_ROUTER), 0);
    }

    function _swapAero(bytes memory inner) internal {
        (address collateralToken,, AeroRoute[] memory aeroRoutes, uint256 amountOutMinimum) =
            abi.decode(inner, (address, address, AeroRoute[], uint256));

        uint256 collBal = IERC20(collateralToken).balanceOf(address(this));
        IERC20(collateralToken).forceApprove(address(AERO_ROUTER), collBal);
        AERO_ROUTER.swapExactTokensForTokens(collBal, amountOutMinimum, aeroRoutes, address(this), block.timestamp);
        IERC20(collateralToken).forceApprove(address(AERO_ROUTER), 0);
    }

    // Decode just the (collateralToken, loanToken) prefix shared by both venue
    // encodings. The V3 encoding packs (address,address,bytes,uint256) and the
    // Aero one (address,address,AeroRoute[],uint256); the first two static
    // words are identical, so decoding them as (address,address) is safe for
    // both and lets the callback learn the loan token without re-branching.
    function _decodeCommon(bytes memory inner)
        internal
        pure
        returns (address collateralToken, address loanToken, uint256, uint256)
    {
        (collateralToken, loanToken) = abi.decode(inner, (address, address));
        return (collateralToken, loanToken, 0, 0);
    }

    /**
     * Sweep the full loan-token balance to `owner` after the repay is settled.
     */
    function _sweep(address token) internal {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(owner(), bal);
    }

    /**
     * Owner-only rescue for stranded balances (collateral dust, airdrops, etc).
     */
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }
}
