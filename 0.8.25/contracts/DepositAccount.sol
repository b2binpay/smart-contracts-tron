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

import {SafeERC20Minimal, IERC20} from "./token/ERC20/utils/SafeERC20Minimal.sol";
import {IFactory} from "./interfaces/IFactory.sol";

/**
 * @dev Initializes the contract by transferring any ERC20 token balance (if applicable)
 * and any Ether balance to the recipient address obtained from the Factory contract,
 * and then self-destructs.
 *
 * Behavior:
 *
 * - Retrieves the recipient and token addresses from the Factory contract.
 * - If the token address is not the zero address:
 * - Transfers the entire ERC20 token balance to the recipient if the balance is greater than zero.
 * - Self-destructs the contract, sending any remaining Ether to the recipient.
 *
 * Notes:
 *
 * - The token address obtained from the Factory contract may be the zero address.
 *   In this case, only the Ether balance will be transferred (if any).
 * - It is assumed that the caller ensures there is a balance to transfer before invoking this constructor.
 */
contract DepositAccount {
    using SafeERC20Minimal for IERC20;

    constructor() payable {
        IFactory factory = IFactory(msg.sender);

        address recipient = factory.recipient();
        IERC20 token = IERC20(factory.token());

        if (address(token) != address(0)) {
            uint256 balance = token.balanceOf(address(this));
            if (balance > 0) {
                token.safeTransfer(recipient, balance);
            }
        }

        selfdestruct(payable(recipient));
    }
}
