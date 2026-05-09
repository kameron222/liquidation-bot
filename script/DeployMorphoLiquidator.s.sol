// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MorphoLiquidator} from "../contracts/MorphoLiquidator.sol";

/**
 * Deploys MorphoLiquidator.sol to Base mainnet.
 *
 * Usage:
 *   forge script script/DeployMorphoLiquidator.s.sol \
 *     --rpc-url base \
 *     --private-key $PRIVATE_KEY \
 *     --broadcast
 *
 * Owner is msg.sender (the broadcasting key). Constants mirror config/morpho.js,
 * config/uniswap.js, and config/aerodrome.js — keep in sync if those change.
 */
contract DeployMorphoLiquidator is Script {
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant AERO_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;

    function run() external returns (address) {
        vm.startBroadcast();
        MorphoLiquidator liquidator = new MorphoLiquidator(MORPHO, SWAP_ROUTER, AERO_ROUTER, msg.sender);
        vm.stopBroadcast();

        console2.log("MorphoLiquidator deployed at:", address(liquidator));
        console2.log("Owner:", msg.sender);
        return address(liquidator);
    }
}
