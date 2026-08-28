// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2025 B2BINPAY https://b2binpay.com
pragma solidity 0.8.25;

import {IERC20} from "../IERC20.sol";

/**
 * @dev TVM specific version. `safeTransfer` for tokens whose `transfer` return value cannot be
 * trusted. TRON USDT (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`) returns `false` from a `transfer` that
 * succeeded, so the returndata is ignored entirely and only the call itself has to succeed.
 *
 * A non-reverting `transfer` is therefore reported as successful even when no balance moved: a
 * successful `safeTransfer` is not proof that the tokens reached `to`. The caller keeps that
 * guarantee elsewhere — off-chain accounting must confirm the movement from `Transfer` logs.
 *
 * A reverting token surfaces as {SafeERC20FailedOperation}; its own revert reason is dropped.
 *
 * Use `using SafeERC20Minimal for IERC20;` to call `token.safeTransfer(...)`.
 */
library SafeERC20Minimal {
    /**
     * @dev The `transfer` call to `token` failed.
     */
    error SafeERC20FailedOperation(address token);

    /**
     * @dev Transfer `value` amount of `token` from the calling contract to `to`. Only the call itself is required
     * to succeed — see the library docs for what that does and does not prove.
     */
    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        (bool success, ) = address(token).call(abi.encodeCall(token.transfer, (to, value)));

        if (!success) {
            revert SafeERC20FailedOperation(address(token));
        }
    }
}
