// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {MultiSigWallet} from "../MultiSigWallet.sol";

/**
 * @dev Harness that misallocates an extension permission inside the base range. Exists to prove that such a
 *      deployment cannot be initialized at all, which is what makes the reserved range hold by construction
 *      instead of by review.
 */
contract MultiSigWalletBadExtensionMock is MultiSigWallet {
    uint256 public constant PERMISSION_BASE_RANGE_COLLISION = 1 << 1;

    /**
     * @dev See {MultiSigWalletPermissions-_extensionPermissions}.
     */
    function _extensionPermissions() internal pure override returns (uint256) {
        return PERMISSION_BASE_RANGE_COLLISION;
    }
}
