// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2025 B2BINPAY https://b2binpay.com
//
// ██████╗ ██████╗ ██████╗ ██╗███╗   ██╗██████╗  █████╗ ██╗   ██╗
// ██╔══██╗╚════██╗██╔══██╗██║████╗  ██║██╔══██╗██╔══██╗╚██╗ ██╔╝
// ██████╔╝ █████╔╝██████╔╝██║██╔██╗ ██║██████╔╝███████║ ╚████╔╝
// ██╔══██╗██╔═══╝ ██╔══██╗██║██║╚██╗██║██╔═══╝ ██╔══██║  ╚██╔╝
// ██████╔╝███████╗██████╔╝██║██║ ╚████║██║     ██║  ██║   ██║
// ╚═════╝ ╚══════╝╚═════╝ ╚═╝╚═╝  ╚═══╝╚═╝     ╚═╝  ╚═╝   ╚═╝
// WEB3 PROCESSING
pragma solidity 0.8.25;

import {Address} from "./utils/Address.sol";
import {Clones} from "./proxy/Clones.sol";

/**
 * @title Proxy Factory - Allows to create ERC-1167 minimal proxy clones and execute a message call to the new proxy within one transaction.
 */
contract ProxyFactory {
    /**
     * @dev Emitted when a new `contract` is created
     */
    event CreateSuccess(address indexed instance);

    /**
     * @dev The deployment failed.
     */
    error FailedDeployment();

    /**
     * @dev Returns the address where a contract will be stored if deployed via {createInstance}. Any change in the
     * `initializer` or `saltNonce` will result in a new destination address.
     *
     * @param implementation The address of the implementation contract to clone.
     * @param initializer Payload for a message call to be sent to a new contract.
     * @param saltNonce Nonce that will be used to generate the salt to calculate the address of the new contract.
     *
     * @return salt Create2 salt to use for calculating the address of the new contract.
     * @return instance The computed address where the contract will be deployed.
     */
    function computeAddress(
        address implementation,
        bytes calldata initializer,
        bytes32 saltNonce
    ) public view returns (bytes32 salt, address instance) {
        salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce));

        instance = Clones.predictDeterministicAddress(implementation, salt, address(this));
    }

    /**
     * @notice Deploys a new ERC-1167 minimal proxy clone using CREATE2. Optionally executes an initializer call to a new contract.
     * @param implementation The address of the implementation contract to clone.
     * @param initializer Payload for a message call to be sent to a new contract.
     * @param saltNonce Nonce that will be used to generate the salt to calculate the address of the new contract.
     */
    function createInstance(
        address implementation,
        bytes calldata initializer,
        bytes32 saltNonce
    ) external returns (address instance) {
        (bytes32 salt, address computedAddress) = computeAddress(implementation, initializer, saltNonce);

        instance = Clones.cloneDeterministic(implementation, salt);

        if (instance != computedAddress) {
            revert FailedDeployment();
        }

        if (initializer.length > 0) {
            Address.functionCall(instance, initializer);
        }

        emit CreateSuccess(instance);
    }
}
