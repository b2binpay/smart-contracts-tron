// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {MultiSigWallet} from "../MultiSigWallet.sol";

/**
 * @dev Harness that applies {MultiSigWalletPermissions-onlyFactoryOrPermitted} to a trivial function and
 *      declares permissions through {MultiSigWalletPermissions-_extensionPermissions}, the way a
 *      chain-specific extension does.
 *      No EVM entry point uses either, so this is where both are unit-tested against the source both chains
 *      compile.
 */
contract MultiSigWalletPermissionMock is MultiSigWallet {
    /**
     * @dev Emitted when a gated function is reached.
     */
    event Gated(address caller);

    /**
     * @dev Extension permissions, allocated above {MultiSigWalletPermissions-BASE_PERMISSION_MASK} the way a real
     *      chain-specific extension allocates its own. Two of them, each gating its own entry point: one bit
     *      would leave the modifier's permission argument indistinguishable from a hardcoded constant, and
     *      {supportedPermissions} must not return a permission with no gate behind it. They sit high in the
     *      extension range on purpose, leaving its low bits undeclared for the rejection tests to use.
     *      Their union is not published as a constant of its own, matching a real extension:
     *      `supportedPermissions() & ~BASE_PERMISSION_MASK` already answers what this deployment adds.
     */
    uint256 public constant PERMISSION_EXTENSION_A = 1 << 200;
    uint256 public constant PERMISSION_EXTENSION_B = 1 << 201;

    /**
     * @notice Reachable through {MultiSigWallet-execute} or by a holder of `PERMISSION_EXTENSION_A`.
     */
    function gatedA() external onlyFactoryOrPermitted(PERMISSION_EXTENSION_A) {
        emit Gated(msg.sender);
    }

    /**
     * @notice Reachable through {MultiSigWallet-execute} or by a holder of `PERMISSION_EXTENSION_B`.
     */
    function gatedB() external onlyFactoryOrPermitted(PERMISSION_EXTENSION_B) {
        emit Gated(msg.sender);
    }

    /**
     * @dev See {MultiSigWalletPermissions-_extensionPermissions}.
     */
    function _extensionPermissions() internal pure override returns (uint256) {
        return PERMISSION_EXTENSION_A | PERMISSION_EXTENSION_B;
    }
}
