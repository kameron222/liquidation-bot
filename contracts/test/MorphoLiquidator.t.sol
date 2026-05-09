// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MorphoLiquidator, MarketParams} from "../MorphoLiquidator.sol";

interface IMorpho {
    function createMarket(MarketParams calldata marketParams) external;
    function supply(MarketParams calldata, uint256 assets, uint256 shares, address onBehalf, bytes calldata data)
        external
        returns (uint256, uint256);
    function supplyCollateral(MarketParams calldata, uint256 assets, address onBehalf, bytes calldata data) external;
    function borrow(MarketParams calldata, uint256 assets, uint256 shares, address onBehalf, address receiver)
        external
        returns (uint256, uint256);
}

// Oracle we fully control, so the fork test doesn't depend on the address of
// any specific live Morpho oracle. Price is scaled 1e36 * 10^(loanDec-collDec);
// for USDC(6)/WETH(18) that's 1e24, so $3000 == 3000e24.
contract MockOracle {
    uint256 public price;

    constructor(uint256 p) {
        price = p;
    }

    function setPrice(uint256 p) external {
        price = p;
    }
}

/**
 * Fork test for MorphoLiquidator.sol against the live Morpho Blue singleton on
 * Base. Rather than lean on a specific live market's oracle address, we create
 * our own market (real singleton + real Adaptive Curve IRM + an enabled LLTV +
 * a mock oracle we can crash) and run a full liquidation through it.
 *
 * Strategy:
 *   1. Fork Base mainnet (requires ALCHEMY_HTTP_URL).
 *   2. createMarket(WETH collateral / USDC loan) with a mock oracle @ $3000.
 *   3. Supply USDC liquidity; as the borrower, supply 10 WETH and borrow ~25k
 *      USDC (just under the 86% LLTV).
 *   4. Crash the mock oracle to $2500 → borrower underwater.
 *   5. owner calls MorphoLiquidator.liquidate: Morpho hands over the seized
 *      WETH, the callback swaps it to USDC on Uniswap V3, Morpho pulls the
 *      repay, and the surplus is swept to owner.
 *   6. Assert owner's USDC grew and the contract retains nothing.
 *
 * Run: `npm run test:fork`.
 */
contract MorphoLiquidatorForkTest is Test {
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant IRM = 0x46415998764C29aB2a25CbeA6254146D50D22687;
    address constant SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant AERO_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    uint256 constant LLTV = 860_000_000_000_000_000; // 86% — a governance-enabled tier

    address owner = address(0xBEEF);
    address borrower = address(0xA11CE);
    address supplier = address(0x5EED);

    MorphoLiquidator liquidator;
    MockOracle oracle;
    MarketParams params;

    function setUp() public {
        vm.createSelectFork(vm.envString("ALCHEMY_HTTP_URL"));
        liquidator = new MorphoLiquidator(MORPHO, SWAP_ROUTER, AERO_ROUTER, owner);
        oracle = new MockOracle(3000e24); // WETH @ $3000

        params = MarketParams({loanToken: USDC, collateralToken: WETH, oracle: address(oracle), irm: IRM, lltv: LLTV});
        IMorpho(MORPHO).createMarket(params);

        // Seed loan-side liquidity so the borrower can draw USDC.
        deal(USDC, supplier, 1_000_000e6);
        vm.startPrank(supplier);
        IERC20(USDC).approve(MORPHO, type(uint256).max);
        IMorpho(MORPHO).supply(params, 1_000_000e6, 0, supplier, "");
        vm.stopPrank();
    }

    function _openUnderwaterBorrower() internal {
        deal(WETH, borrower, 10 ether);
        vm.startPrank(borrower);
        IERC20(WETH).approve(MORPHO, type(uint256).max);
        IMorpho(MORPHO).supplyCollateral(params, 10 ether, borrower, "");
        // 10 WETH * $3000 * 86% = $25,800 capacity; borrow $25,000.
        IMorpho(MORPHO).borrow(params, 25_000e6, 0, borrower, borrower);
        vm.stopPrank();

        // Crash to $2500: capacity falls to $21,500 < $25,000 debt → unhealthy.
        oracle.setPrice(2500e24);
    }

    function test_liquidates_and_owner_profits() public {
        _openUnderwaterBorrower();

        uint256 seized = 2 ether; // ~$5000 of WETH at the crashed price
        bytes memory swapPath = abi.encodePacked(WETH, uint24(500), USDC);

        uint256 ownerUsdcBefore = IERC20(USDC).balanceOf(owner);

        vm.prank(owner);
        liquidator.liquidate(params, borrower, seized, swapPath, 0);

        uint256 profit = IERC20(USDC).balanceOf(owner) - ownerUsdcBefore;
        // Seizing $5000 of WETH repays ~$4790 (LIF ≈ 1.0438 at 86% LLTV), so
        // gross edge is ~$210. Even under heavy V3 slippage the owner clears a
        // few dollars — and there is no flash-loan premium on this path.
        assertGt(profit, 3e6, "owner profit too low");

        // Contract retains neither the loan nor the collateral asset.
        assertEq(IERC20(USDC).balanceOf(address(liquidator)), 0, "retains USDC");
        assertEq(IERC20(WETH).balanceOf(address(liquidator)), 0, "retains WETH");
    }

    function test_only_owner_can_liquidate() public {
        _openUnderwaterBorrower();
        bytes memory swapPath = abi.encodePacked(WETH, uint24(500), USDC);
        vm.expectRevert();
        liquidator.liquidate(params, borrower, 1 ether, swapPath, 0);
    }

    function test_callback_rejects_non_morpho_caller() public {
        vm.expectRevert(MorphoLiquidator.NotMorpho.selector);
        liquidator.onMorphoLiquidate(0, "");
    }
}
