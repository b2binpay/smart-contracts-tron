// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IERC1271} from "../interfaces/IERC1271.sol";
import {ECDSA} from "../utils/cryptography/ECDSA.sol";

/**
 * @dev Mock ERC-1271 contract that validates signatures using a single EOA signer.
 */
contract ERC1271Mock is IERC1271 {
    address public signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
        if (ECDSA.recover(hash, signature) == signer) {
            return IERC1271.isValidSignature.selector;
        }
        return 0x00000000;
    }
}

/**
 * @dev Mock that always rejects signatures.
 */
contract ERC1271RejectMock is IERC1271 {
    function isValidSignature(bytes32, bytes calldata) external pure override returns (bytes4) {
        return 0x00000000;
    }
}

/**
 * @dev Mock that always reverts.
 */
contract ERC1271RevertMock is IERC1271 {
    function isValidSignature(bytes32, bytes calldata) external pure override returns (bytes4) {
        revert("ERC1271RevertMock: always reverts");
    }
}
