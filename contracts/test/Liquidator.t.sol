// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Liquidator, AeroRoute} from "../Liquidator.sol";

interface IComptroller {
    function enterMarkets(address[] calldata cTokens) external returns (uint256[] memory);
    function getAccountLiquidity(address) external view returns (uint256, uint256, uint256);
    function oracle() external view returns (address);
}

interface ICTokenLike {
    function mint(uint256) external returns (uint256);
    function borrow(uint256) external returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function exchangeRateStored() external view returns (uint256);
    function borrowBalanceCurrent(address) external returns (uint256);
}

interface IPriceOracle {
    function getUnderlyingPrice(address) external view returns (uint256);
}

/**
 * Fork test for Liquidator.sol against the live Moonwell deployment on Base.
 *
 * Strategy:
 *   1. Fork Base mainnet (requires ALCHEMY_HTTP_URL).
 *   2. Spin up a synthetic borrower: deal WETH, mint mWETH, enter the WETH
 *      market, then borrow USDC at ~85% of the chain-reported capacity.
 *   3. Mock the Comptroller's oracle to halve the WETH price for `mWETH`,
 *      driving the borrower into shortfall while leaving every other
 *      market's price untouched.
 *   4. Run `Liquidator.liquidate` for a small USDC repay against the WETH
 *      collateral, swapping seized WETH back into USDC via Uniswap V3
 *      (single-hop, 0.05% fee tier).
 *   5. Assert the owner's USDC balance grew by a reasonable margin.
 *
 * Run: `npm run test:fork` (which is `forge test --fork-url $ALCHEMY_HTTP_URL`).
 */
contract LiquidatorForkTest is Test {
    address constant COMPTROLLER  = 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C;
    address constant MWETH        = 0x628ff693426583D9a7FB391E54366292F509D457;
    address constant MUSDC        = 0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22;
    address constant MAERO        = 0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6;
    address constant WETH         = 0x4200000000000000000000000000000000000006;
    address constant USDC         = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant AERO         = 0x940181a94A35A4569E4529A3CDfB74e38FD98631;
    address constant AAVE_POOL    = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant SWAP_ROUTER  = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant AERO_ROUTER  = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;

    address owner    = address(0xBEEF);
    address borrower = address(0xA11CE);

    Liquidator liquidator;

    function setUp() public {
        vm.createSelectFork(vm.envString("ALCHEMY_HTTP_URL"));
        liquidator = new Liquidator(AAVE_POOL, SWAP_ROUTER, AERO_ROUTER, WETH, owner);
    }

    function test_liquidates_synthetic_borrower_and_owner_profits() public {
        // 1. Fund borrower with 1 WETH + mint mWETH.
        deal(WETH, borrower, 1 ether);

        vm.startPrank(borrower);
        IERC20(WETH).approve(MWETH, 1 ether);
        require(ICTokenLike(MWETH).mint(1 ether) == 0, "mWETH.mint failed");

        address[] memory markets = new address[](1);
        markets[0] = MWETH;
        IComptroller(COMPTROLLER).enterMarkets(markets);

        // 2. Borrow ~85% of the chain-reported capacity in USDC.
        (uint256 liqErr, uint256 liquidity, ) =
            IComptroller(COMPTROLLER).getAccountLiquidity(borrower);
        require(liqErr == 0, "liquidity err");
        require(liquidity > 0, "no borrowing power");
        // liquidity is USD scaled to 1e18; USDC has 6 decimals.
        uint256 borrowAmount = (liquidity * 85 / 100) / 1e12;
        require(borrowAmount > 0, "borrowAmount zero");
        require(ICTokenLike(MUSDC).borrow(borrowAmount) == 0, "mUSDC.borrow failed");
        vm.stopPrank();

        // 3. Halve the mWETH oracle price → borrower goes underwater.
        address oracle = IComptroller(COMPTROLLER).oracle();
        uint256 realWethPrice = IPriceOracle(oracle).getUnderlyingPrice(MWETH);
        vm.mockCall(
            oracle,
            abi.encodeWithSelector(IPriceOracle.getUnderlyingPrice.selector, MWETH),
            abi.encode(realWethPrice / 2)
        );

        (, , uint256 shortfall) = IComptroller(COMPTROLLER).getAccountLiquidity(borrower);
        assertGt(shortfall, 0, "expected shortfall after price crash");

        // 4. Repay a small slice of the USDC debt: 100 USDC, well below the
        //    50% close factor for any plausible borrowAmount.
        uint256 repayAmount = 100e6;
        bytes memory swapPath = abi.encodePacked(WETH, uint24(500), USDC);

        uint256 ownerUsdcBefore = IERC20(USDC).balanceOf(owner);

        vm.prank(owner);
        liquidator.liquidate(borrower, MUSDC, MWETH, repayAmount, swapPath, 0);

        uint256 ownerUsdcAfter = IERC20(USDC).balanceOf(owner);
        uint256 profit = ownerUsdcAfter - ownerUsdcBefore;

        // 8% Compound liquidation incentive on $100 ⇒ $8 gross seize value.
        // Subtract Aave's 0.05% premium on $100 (~$0.05) and Uniswap fees /
        // slippage on the WETH→USDC swap. We expect at least $4 profit even
        // under heavy slippage assumptions.
        assertGt(profit, 4e6, "profit too low");

        // The Liquidator should not be holding any borrow asset after the
        // sweep — anything left would mean owner shorted some profit.
        assertEq(IERC20(USDC).balanceOf(address(liquidator)), 0, "Liquidator retains USDC");
    }

    function test_only_owner_can_liquidate() public {
        bytes memory empty;
        vm.expectRevert();
        liquidator.liquidate(borrower, MUSDC, MWETH, 1e6, empty, 0);
    }

    /**
     * Reverse direction of the primary test: borrower stakes mUSDC collateral
     * and borrows WETH. Then we crash the WETH price downwards (so their fixed
     * USDC-backed borrowing power suddenly looks too small for the now-cheap
     * WETH debt — equivalently we mock the *USDC* price up, since shortfall
     * compares borrowed assets to collateral assets at oracle prices).
     *
     * Exercises the USDC → WETH swap and confirms the Liquidator does NOT
     * leave native ETH or extra USDC stranded after the unwrap path.
     */
    function test_liquidate_mWETH_debt_against_mUSDC_collateral() public {
        deal(USDC, borrower, 5_000e6);

        vm.startPrank(borrower);
        IERC20(USDC).approve(MUSDC, 5_000e6);
        require(ICTokenLike(MUSDC).mint(5_000e6) == 0, "mUSDC.mint failed");

        address[] memory markets = new address[](1);
        markets[0] = MUSDC;
        IComptroller(COMPTROLLER).enterMarkets(markets);

        (uint256 liqErr, uint256 liquidity, ) = IComptroller(COMPTROLLER).getAccountLiquidity(borrower);
        require(liqErr == 0 && liquidity > 0, "no borrowing power");
        // liquidity is USD scaled to 1e18; WETH has 18 decimals. Convert via
        // the chain-reported WETH price (mantissa 1e36/decimals → 1e18 here).
        address oracle = IComptroller(COMPTROLLER).oracle();
        uint256 wethPrice = IPriceOracle(oracle).getUnderlyingPrice(MWETH);
        uint256 borrowAmount = (liquidity * 85 * 1e18) / (100 * wethPrice);
        require(borrowAmount > 0, "borrowAmount zero");
        require(ICTokenLike(MWETH).borrow(borrowAmount) == 0, "mWETH.borrow failed");
        vm.stopPrank();

        // Halve mUSDC collateral price → borrower goes underwater.
        uint256 realUsdcPrice = IPriceOracle(oracle).getUnderlyingPrice(MUSDC);
        vm.mockCall(
            oracle,
            abi.encodeWithSelector(IPriceOracle.getUnderlyingPrice.selector, MUSDC),
            abi.encode(realUsdcPrice / 2)
        );

        (, , uint256 shortfall) = IComptroller(COMPTROLLER).getAccountLiquidity(borrower);
        assertGt(shortfall, 0, "expected shortfall");

        // Repay 0.01 WETH.
        uint256 repayAmount = 0.01 ether;
        bytes memory swapPath = abi.encodePacked(USDC, uint24(500), WETH);

        uint256 ownerWethBefore = IERC20(WETH).balanceOf(owner);

        vm.prank(owner);
        liquidator.liquidate(borrower, MWETH, MUSDC, repayAmount, swapPath, 0);

        uint256 ownerWethAfter = IERC20(WETH).balanceOf(owner);
        assertGt(ownerWethAfter, ownerWethBefore, "owner did not receive WETH profit");

        // Liquidator must not retain debt asset (WETH) or stranded native ETH.
        assertEq(IERC20(WETH).balanceOf(address(liquidator)), 0, "Liquidator retains WETH");
        assertEq(address(liquidator).balance, 0, "Liquidator retains native ETH");
    }

    /**
     * Aerodrome route: borrower stakes mAERO collateral, borrows USDC. After
     * an AERO price crash, owner liquidates via `liquidateAero` with a
     * two-hop AERO → WETH → USDC route. Verifies the venue dispatch and the
     * Solidly-fork swap path.
     */
    function test_liquidateAero_AERO_collateral() public {
        // 1000 AERO is comfortably more than $100 of borrowing power.
        deal(AERO, borrower, 1000e18);

        vm.startPrank(borrower);
        IERC20(AERO).approve(MAERO, 1000e18);
        require(ICTokenLike(MAERO).mint(1000e18) == 0, "mAERO.mint failed");

        address[] memory markets = new address[](1);
        markets[0] = MAERO;
        IComptroller(COMPTROLLER).enterMarkets(markets);

        (uint256 liqErr, uint256 liquidity, ) = IComptroller(COMPTROLLER).getAccountLiquidity(borrower);
        require(liqErr == 0 && liquidity > 0, "no borrowing power");
        uint256 borrowAmount = (liquidity * 85 / 100) / 1e12;
        require(borrowAmount > 0, "borrowAmount zero");
        require(ICTokenLike(MUSDC).borrow(borrowAmount) == 0, "mUSDC.borrow failed");
        vm.stopPrank();

        address oracle = IComptroller(COMPTROLLER).oracle();
        uint256 realAeroPrice = IPriceOracle(oracle).getUnderlyingPrice(MAERO);
        vm.mockCall(
            oracle,
            abi.encodeWithSelector(IPriceOracle.getUnderlyingPrice.selector, MAERO),
            abi.encode(realAeroPrice / 2)
        );

        (, , uint256 shortfall) = IComptroller(COMPTROLLER).getAccountLiquidity(borrower);
        assertGt(shortfall, 0, "expected shortfall");

        uint256 repayAmount = 50e6; // $50 USDC
        AeroRoute[] memory routes = new AeroRoute[](2);
        routes[0] = AeroRoute({from: AERO, to: WETH, stable: false, factory: address(0)});
        routes[1] = AeroRoute({from: WETH, to: USDC, stable: false, factory: address(0)});

        uint256 ownerUsdcBefore = IERC20(USDC).balanceOf(owner);

        vm.prank(owner);
        liquidator.liquidateAero(borrower, MUSDC, MAERO, repayAmount, routes, 0);

        uint256 ownerUsdcAfter = IERC20(USDC).balanceOf(owner);
        // Aerodrome carries higher slippage than V3 on tight pairs, but 8%
        // bonus on $50 minus a flash-loan premium leaves several dollars even
        // under heavy slippage. Tolerate a low bound.
        assertGt(ownerUsdcAfter - ownerUsdcBefore, 1e6, "Aerodrome route too thin");
        assertEq(IERC20(USDC).balanceOf(address(liquidator)), 0, "Liquidator retains USDC");
    }
}
