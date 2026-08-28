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

/**
 * @dev Contract to manage the creation and handling of `DepositAccount` contracts.
 * The Factory contract allows the owner to deploy `DepositAccount` contracts using `CREATE2` and
 * collect tokens or Ether from the deployed contracts. The recipient of funds can be
 * only the owner, and only the owner is allowed to manage the deposits.
 * @notice Adapted for ERC-1167 minimal proxy clones.
 */
contract FactoryA is IFactory {
    // The address of the contract owner who has exclusive rights to manage deposits
    address private _owner;

    // The address where collected funds will be transferred; initially set to the owner
    address private _recipient;

    // The address of the ERC20 token to be used for claim operations
    address private _token;

    /**
     * @dev The contract is already initialized.
     */
    error InvalidInitialization();

    /**
     * @dev Triggered when the contract has been initialized.
     */
    event Initialized();

    /**
     * @dev Ensures that only the contract owner can call the modified function.
     */
    modifier onlyOwner() {
        if (_owner != msg.sender) {
            revert UnauthorizedAccount(msg.sender);
        }
        _;
    }

    /**
     * @dev Sets the recipient address for the current operation.
     * @param to The recipient address to be used in the `claim` operation.
     */
    modifier withRecipient(address to) {
        if (to == address(0)) {
            revert InvalidRecipient(address(0));
        }

        _recipient = to;
        _;
        _recipient = _owner;
    }

    /**
     * @dev Sets the token address for the current operation.
     * If necessary, the token address can be reset by calling `claim` with a zero address and zero salt.
     * @param erc20 The address of the ERC20 token to be used in the `claim` operation.
     */
    modifier withToken(address erc20) {
        _token = erc20;
        _;
        _token = address(0);
    }

    /**
     * @dev Initializes the contract, setting the deployer as the owner and recipient.
     * This constructor ensures that this contract can be used as an implementation/singleton.
     * By setting the owner to address(1), it prevents further initialization calls,
     * making this contract suitable as an implementation for ProxyFactory.
     */
    constructor() {
        _owner = address(1);
        _recipient = address(1);
    }

    /**
     * @dev Initializes the contract with the specified owner.
     * This method can only be called once and only when owner is not set (for proxy clones).
     * @param owner_ The address that will become the owner of the contract.
     */
    function initialize(address owner_) external {
        if (_owner != address(0)) {
            revert InvalidInitialization();
        }
        if (owner_ == address(0)) {
            revert InvalidRecipient(address(0));
        }
        _owner = owner_;
        _recipient = owner_;

        emit Initialized();
    }

    /**
     * @dev Returns the address of the owner.
     * @return The address of the contract owner.
     */
    function owner() public view returns (address) {
        return _owner;
    }

    /**
     * @dev Returns the current recipient address for funds.
     * @return The address that will receive the funds from `DepositAccount` contracts.
     */
    function recipient() public view returns (address) {
        return _recipient;
    }

    /**
     * @dev Returns the address of the current token for `claim` operations.
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
     * @dev Returns an array of the `DepositAccount` addresses for `claim` transactions.
     * @param accountIds An array of unique IDs of the accounts used for the deterministic computation of the address.
     *
     * @return accountIds An array of the provided unique IDs.
     * @return accounts An array of computed addresses corresponding to each IDs.
     */
    function getAccounts(
        bytes32[] memory accountIds
    ) public view returns (bytes32[] memory, address[] memory accounts) {
        bytes memory bytecode = type(DepositAccount).creationCode;

        bytes32 bytecodeHash = keccak256(bytecode);

        accounts = new address[](accountIds.length);

        for (uint256 i = 0; i < accountIds.length; i++) {
            accounts[i] = Create2.computeAddress(accountIds[i], bytecodeHash, address(this));
        }

        return (accountIds, accounts);
    }

    /**
     * @dev Transfers funds from multiple `DepositAccount` in a single transaction.
     *
     * @param erc20 The address of the ERC20 token to collect (address(0) for ETH only).
     * @param accountIds An array of unique IDs of the accounts.
     *
     * Requirements:
     *
     * - the caller must be `owner`
     * - uses the provided token for all claims
     * - IDs array must contain unique values to avoid conflicts
     */
    function claim(address erc20, bytes32[] calldata accountIds) external onlyOwner withToken(erc20) {
        _claim(erc20, accountIds);
    }

    /**
     * @dev Transfers funds to the specific address from multiple `DepositAccount` in a single transaction.
     * Temporarily changes the recipient address to `_to` for this claim only.
     * The recipient is reset to the owner after the function completes.
     * @param to The recipient address to receive the claimed funds.
     * @param erc20 The address of the ERC20 token to collect (address(0) for ETH only).
     * @param accountIds An array of unique IDs of the accounts.
     *
     * Requirements:
     *
     * - `to` cannot be the zero address.
     * - the caller must be `owner`
     * - uses the provided token for all claims
     * - IDs array must contain unique values to avoid conflicts
     */
    function claimTo(
        address to,
        address erc20,
        bytes32[] calldata accountIds
    ) external onlyOwner withRecipient(to) withToken(erc20) {
        _claim(erc20, accountIds);
    }

    /**
     * @dev Deploys `DepositAccount` contract at a computed address using `CREATE2` and claim funds.
     * Only callable internally to ensure controlled deployment of `DepositAccount` contracts.
     *
     * Emits a {Claim} event upon successful deployment and fund collection.
     *
     * @param erc20 The address of the ERC20 token to collect (address(0) for ETH only).
     * @param accountIds An array of unique IDs of the accounts.
     */
    function _claim(address erc20, bytes32[] calldata accountIds) private {
        bytes memory bytecode = type(DepositAccount).creationCode;

        (, address[] memory accounts) = getAccounts(accountIds);

        for (uint256 i = 0; i < accountIds.length; i++) {
            uint256 ethAmount = accounts[i].balance;

            uint256 erc20Amount = 0;
            if (erc20 != address(0)) {
                erc20Amount = IERC20(erc20).balanceOf(accounts[i]);
            }

            address deposit = Create2.deploy(0, accountIds[i], bytecode);

            if (deposit != accounts[i]) {
                revert FailedDeployment();
            }

            emit Claim(_recipient, accounts[i], erc20, erc20Amount, ethAmount);
        }
    }
}
