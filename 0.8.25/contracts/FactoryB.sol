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

import {DepositAccount, IERC20} from "./DepositAccount.sol";
import {IFactory} from "./interfaces/IFactory.sol";
import {Create2} from "./utils/Create2.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";

/**
 * @dev Contract through which it is possible to compute a deposit address using `CREATE2`
 * to receive ETH, ERC20 tokens and to collect deposits into one transaction.
 */
contract FactoryB is ReentrancyGuard, IFactory {
    // Address where collected funds will be transferred; initially set to the owner
    address private _recipient;

    // Address of the ERC20 token to be used for deposit operations
    address private _token;

    /**
     * @dev Returns the current recipient address for funds.
     * @return The address that will receive the funds from `DepositAccount` contracts.
     */
    function recipient() public view returns (address) {
        return _recipient;
    }

    /**
     * @dev Returns the address of the current token for deposit operations.
     * @return The address of the token being used for the current transaction.
     */
    function token() public view returns (address) {
        return _token;
    }

    /**
     * @dev Returns the version of the Factory contract.
     * @return The version of the Factory contract as a string.
     */
    function version() public pure returns (string memory) {
        return "1.0.0";
    }

    /**
     * @dev Returns the `DepositAccount` address for `claim` transactions.
     * @param recipient_ The recipient address used for deterministic computation.
     * @param accountId Unique ID of the account used for the deterministic computation of the address.
     *
     * @return bytecode deposit smart contract.
     * @return hash with which the address was formed.
     * @return account address where funds are collected.
     */
    function getAccount(
        address recipient_,
        bytes32 accountId
    ) public view returns (bytes memory bytecode, bytes32 hash, address account) {
        if (recipient_ == address(0)) {
            revert InvalidRecipient(address(0));
        }

        hash = keccak256(abi.encodePacked(recipient_, accountId));

        bytecode = type(DepositAccount).creationCode;

        account = Create2.computeAddress(hash, keccak256(bytecode), address(this));
    }

    /**
     * @dev Returns batch of the `DepositAccount` addresses where a contract will be stored for `claim` transactions.
     *
     * @param recipients An array of the address of the recipients.
     * @param accountIds An array of the ids of the accounts.
     *
     * @return hashes An array of computed hashes.
     * @return accounts An array of computed deposit contract addresses corresponding to each hash.
     */
    function getAccounts(
        address[] memory recipients,
        bytes32[] memory accountIds
    ) public view returns (bytes32[] memory hashes, address[] memory accounts) {
        if (recipients.length != accountIds.length) {
            revert InvalidArrayLength(recipients.length, accountIds.length);
        }

        accounts = new address[](recipients.length);
        hashes = new bytes32[](recipients.length);

        for (uint256 i = 0; i < recipients.length; i++) {
            (, hashes[i], accounts[i]) = getAccount(recipients[i], accountIds[i]);
        }

        return (hashes, accounts);
    }

    /**
     * @dev Transfers funds from multiple `DepositAccount` contracts in a single transaction.
     *
     * @param token_ The address of the ERC20 token to collect from each `DepositAccount` (address(0) for ETH only).
     * @param recipients An array of address of the recipients used to compute `DepositAccount` addresses.
     * @param accountIds An array of IDs of the accounts used to compute `DepositAccount` addresses.
     *
     * Requirements:
     *
     * - uses the provided token for all claims
     */
    function claim(address token_, address[] calldata recipients, bytes32[] calldata accountIds) external nonReentrant {
        if (recipients.length != accountIds.length) {
            revert InvalidArrayLength(recipients.length, accountIds.length);
        }

        for (uint256 i = 0; i < recipients.length; i++) {
            _claim(token_, recipients[i], accountIds[i]);
        }
    }

    /**
     * @dev Deploys `DepositAccount` contract at a computed address using `CREATE2` and transfer funds.
     * Only callable internally to ensure controlled deployment of `DepositAccount` contracts.
     *
     *  Note: Each `DepositAccount` is deterministically derived from (recipient, accountId).
     *
     * Emits a {Claim} event upon successful deployment and fund collection.
     *
     * @param token_ The address of the ERC20 token to collect.
     * @param recipient_ The address of the recipient.
     * @param accountId The ID of the account.
     */
    function _claim(address token_, address recipient_, bytes32 accountId) private {
        _token = token_;
        _recipient = recipient_;

        (bytes memory bytecode, bytes32 hash, address account) = getAccount(recipient_, accountId);

        uint256 ethAmount = account.balance;

        uint256 erc20Amount = 0;
        if (token_ != address(0)) {
            erc20Amount = IERC20(token_).balanceOf(account);
        }

        address deposit = Create2.deploy(0, hash, bytecode);

        if (deposit != account) {
            revert FailedDeployment();
        }

        emit Claim(recipient_, account, token_, erc20Amount, ethAmount);

        _token = address(0);
        _recipient = address(0);
    }
}
