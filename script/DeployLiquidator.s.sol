// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Liquidator} from "../contracts/Liquidator.sol";

/**
 * Deploys Liquidator.sol to Base mainnet.
 *
 * Usage:
 *   forge script script/DeployLiquidator.s.sol \
 *     --rpc-url base \
 *     --private-key $PRIVATE_KEY \
 *     --broadcast
 *
 * Owner is the msg.sender (i.e. the broadcasting key). Constants mirror
 * config/aave.js and config/uniswap.js — keep in sync if those change.
 */
contract DeployLiquidator is Script {
    address constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant AERO_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant WETH = 0x4200000000000000000000000000000000000006;

    function run() external returns (address) {
        vm.startBroadcast();
        Liquidator liquidator = new Liquidator(AAVE_POOL, SWAP_ROUTER, AERO_ROUTER, WETH, msg.sender);
        vm.stopBroadcast();

        console2.log("Liquidator deployed at:", address(liquidator));
        console2.log("Owner:", msg.sender);
        return address(liquidator);
    }
}
