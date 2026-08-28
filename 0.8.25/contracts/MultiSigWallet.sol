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

import {DepositAccount, SafeERC20Minimal, IERC20} from "./DepositAccount.sol";
import {IFactory} from "./interfaces/IFactory.sol";
import {IERC1271} from "./interfaces/IERC1271.sol";
import {Address} from "./utils/Address.sol";
import {Create2} from "./utils/Create2.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";
import {ECDSA} from "./utils/cryptography/ECDSA.sol";
import {EIP712} from "./utils/cryptography/EIP712.sol";
import {EnumerableSet} from "./utils/structs/EnumerableSet.sol";

/**
 * @dev MultiSig contract through which it is possible to compute a deposit address using `CREATE2`
 * to receive ETH, ERC20 tokens and to collect or payout deposits into one transaction.
 */
contract MultiSigWallet is EIP712, ReentrancyGuard, IERC1271, IFactory {
    using EnumerableSet for EnumerableSet.AddressSet;
    using SafeERC20Minimal for IERC20;

    error InvalidOwner(address owner);
    error DuplicateOwner(address owner);
    error InvalidSignature(address owner);
    error InvalidSignatureOrder(address owner);
    error InvalidSignatureData();
    error InvalidSignatureLength(uint256 length);
    error InsufficientSignatures(uint256 signatures, uint256 threshold);
    error InvalidRequirement(uint256 ownerCount, uint256 threshold);
    error InvalidWhitelistUpdate(uint256 accounts, uint256 statuses);
    error InvalidWhitelistAddress(address account);
    error SetupFail(uint256 ownerCount, uint256 threshold);

    /**
     * @dev Emitted when a batch execution with `nonce` is successfully completed.
     */
    event ExecuteSuccess(uint256 indexed nonce, bytes32 indexed digest, bytes32 indexed id);

    /**
     * @dev Emitted when the contract owners and threshold are set up.
     */
    event SetConfig(address sender, uint256 ownerCount, uint256 threshold);

    /**
     * @dev Emitted when a whitelist entry is added or removed.
     */
    event SetWhitelist(address indexed account, bool status);

    // EIP-712 typehash for call
    bytes32 internal constant CALL_TYPEHASH = keccak256("Call(address to,uint256 value,bytes data)");

    // EIP-712 typehash for batch execution
    bytes32 internal constant EXECUTE_TYPEHASH =
        keccak256("Execute(Call[] calls,uint256 nonce)Call(address to,uint256 value,bytes data)");

    /**
     * @dev Represents a single call to contract.
     * - `to`: The address of the contract to call.
     * - `value`: The amount of Ether (in wei) to send with the call.
     * - `data`: The calldata to send with the call.
     */
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    /**
     * @dev Represents a single operation to be executed by the multisig contract.
     * - `calls`: The contract calls.
     * - `signatures`: Signatures for calls.
     * - `id`: The ID of the operation.
     */
    struct Operation {
        Call[] calls;
        bytes signatures;
        bytes32 id;
    }

    uint256 public constant MAX_OWNER_COUNT = 50;

    // Packed signature header: 20 bytes (signer address) + 2 bytes (uint16 BE signature length)
    uint8 private constant SIGNER_LENGTH = 20;
    uint8 private constant SIG_HEADER_LENGTH = 22;
    uint8 private constant ECDSA_SIGNATURE_LENGTH = 65;
    uint8 private constant MIN_RESULT_LENGTH = 32;

    // Address where collected funds will be transferred; initially set to the owner
    address private _recipient;

    // Address of the ERC20 token to be used for deposit operations
    address private _token;

    // List of addresses that control the `Factory`
    EnumerableSet.AddressSet private _owners;

    // Set of addresses authorized to call `claim` (in addition to owners)
    EnumerableSet.AddressSet private _whitelist;

    // Number of owners required to approve a transaction
    uint256 private _threshold;

    // Each transaction should have a different nonce to prevent replay attacks.
    uint256 private _nonce;

    /**
     * @dev Restricts function calls to only be made through the factory contract itself.
     */
    modifier onlyFactory() {
        if (msg.sender != address(this)) {
            revert UnauthorizedAccount(msg.sender);
        }
        _;
    }

    /**
     * @dev Restricts function calls to owners and whitelisted addresses.
     */
    modifier onlyOwnerOrWhitelisted() {
        if (!_owners.contains(msg.sender) && !_whitelist.contains(msg.sender)) {
            revert UnauthorizedAccount(msg.sender);
        }
        _;
    }

    /**
     * @dev Validates owner count and threshold requirements.
     */
    modifier validRequirements(uint256 ownerCount, uint256 threshold_) {
        if (ownerCount > MAX_OWNER_COUNT || threshold_ > ownerCount || threshold_ == 0) {
            revert InvalidRequirement(ownerCount, threshold_);
        }
        _;
    }

    /**
     * @dev This constructor ensures that this contract can be called by ProxyFactory contracts for `setup`.
     */
    constructor() EIP712("MultiSigWallet", version()) {
        /**
         * Initialize with non-zero threshold to prevent further setup calls,
         * making this contract suitable as an implementation/singleton
         * By setting the threshold it is not possible to call setup anymore,
         * so init with 0 owners and threshold 1.
         */
        _threshold = 1;
    }

    /**
     * @dev The contract should be able to receive ETH.
     */
    receive() external payable virtual {}

    /**
     * @notice Sets an initial owners.
     * @dev This method can only be called once.
     *      If a contract was created without setting up, anyone can call setup and claim the contract.
     * @param owners_ List of owners.
     * @param threshold_ Number of required confirmations for a transaction.
     */
    function setup(address[] calldata owners_, uint256 threshold_) external {
        if (_owners.length() == 0 && _threshold == 0) {
            _setConfig(owners_, threshold_);
        } else {
            revert SetupFail(_owners.length(), _threshold);
        }
    }

    /**
     * @dev Returns the version of the contract.
     * @return The version of the contract as a string.
     */
    function version() public pure returns (string memory) {
        return "1.2.0";
    }

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
     * @dev Returns the threshold.
     * @return Threshold number.
     */
    function threshold() public view returns (uint256) {
        return _threshold;
    }

    /**
     * @dev Returns the nonce of the contract.
     * @return Nonce.
     */
    function nonce() public view returns (uint256) {
        return _nonce;
    }

    /**
     * @notice Returns a list of owners.
     * @return Array of owners.
     */
    function owners() public view returns (address[] memory) {
        return _owners.values();
    }

    /**
     * @notice Returns if `owner` is an owner.
     * @return Boolean if `owner` is an owner.
     */
    function isOwner(address account) public view returns (bool) {
        return _owners.contains(account);
    }

    /**
     * @notice Returns a list of whitelisted addresses.
     * @return Array of whitelisted addresses.
     */
    function whitelist() public view returns (address[] memory) {
        return _whitelist.values();
    }

    /**
     * @notice Returns if `account` is whitelisted.
     * @return Boolean if `account` is whitelisted.
     */
    function isWhitelisted(address account) public view returns (bool) {
        return _whitelist.contains(account);
    }

    /**
     * @dev See {IERC1271}.
     */
    function isValidSignature(bytes32 hash, bytes calldata signatures) public view returns (bytes4 magicValue) {
        try this.checkSignatures(hash, signatures) {
            return IERC1271.isValidSignature.selector;
        } catch {
            return 0x00000000;
        }
    }

    /**
     * @dev Returns the `DepositAccount` address for `claim` transactions.
     *
     * @param accountId Unique ID of the account used for the deterministic computation of the address.
     *
     * @return bytecode The creation bytecode of the contract.
     * @return account The computed address where the contract will be deployed.
     */
    function getAccount(bytes32 accountId) public view returns (bytes memory bytecode, address account) {
        bytecode = type(DepositAccount).creationCode;

        account = Create2.computeAddress(accountId, keccak256(bytecode), address(this));
    }

    /**
     * @dev Returns batch of the `DepositAccount` addresses where a contract will be stored for `claim` transactions.
     *
     * @param accountIds An array of the IDs of the accounts.
     *
     * @return accountIds An array of the provided IDs.
     * @return accounts An array of computed addresses corresponding to each salt
     */
    function getAccounts(
        bytes32[] calldata accountIds
    ) public view returns (bytes32[] memory, address[] memory accounts) {
        accounts = new address[](accountIds.length);

        for (uint256 i = 0; i < accountIds.length; i++) {
            (, accounts[i]) = getAccount(accountIds[i]);
        }

        return (accountIds, accounts);
    }

    /**
     * @dev Checks whether the signature provided is valid for the provided data hash. Reverts otherwise.
     * @notice Signatures use packed format: [signer:20 bytes][sigLen:2 bytes (uint16 BE)][sig:sigLen bytes] x N.
     * Signers must be sorted in strictly ascending address order, and must not contain duplicates.
     *
     * For EOA signers, the signature is verified using ECDSA recovery.
     * For contract signers, the signature is verified using ERC-1271 (`isValidSignature`).
     *
     * @param hash Hash of the data (could be either a message hash or transaction hash)
     * @param signatures Packed signature data that should be verified.
     */
    function checkSignatures(bytes32 hash, bytes calldata signatures) external view {
        // Cache threshold to avoid repeated storage reads in the loop
        uint256 threshold_ = _threshold;
        uint256 validSignatures = 0;
        address lastSigner = address(0);
        uint256 offset = 0;

        while (offset < signatures.length && validSignatures < threshold_) {
            if (offset + SIG_HEADER_LENGTH > signatures.length) {
                revert InvalidSignatureData();
            }

            address signer = address(bytes20(signatures[offset:offset + SIGNER_LENGTH]));
            uint16 sigLen = uint16(bytes2(signatures[offset + SIGNER_LENGTH:offset + SIG_HEADER_LENGTH]));
            offset += SIG_HEADER_LENGTH;

            if (offset + sigLen > signatures.length) {
                revert InvalidSignatureData();
            }

            bytes calldata sig = signatures[offset:offset + sigLen];
            offset += sigLen;

            if (!_owners.contains(signer)) {
                revert InvalidSignature(signer);
            }

            if (signer <= lastSigner) {
                revert InvalidSignatureOrder(signer);
            }

            lastSigner = signer;

            if (signer.code.length == 0) {
                // EOA: ECDSA verification (only 65-byte signatures supported)
                if (sigLen != ECDSA_SIGNATURE_LENGTH) {
                    revert InvalidSignatureLength(sigLen);
                }
                if (ECDSA.recover(hash, sig) != signer) {
                    revert InvalidSignature(signer);
                }
            } else {
                // Contract: ERC-1271 staticcall
                (bool success, bytes memory result) = signer.staticcall(
                    abi.encodeWithSelector(IERC1271.isValidSignature.selector, hash, sig)
                );
                if (
                    !success ||
                    result.length < MIN_RESULT_LENGTH ||
                    abi.decode(result, (bytes4)) != IERC1271.isValidSignature.selector
                ) {
                    revert InvalidSignature(signer);
                }
            }

            validSignatures++;
        }

        if (validSignatures < threshold_) {
            revert InsufficientSignatures(validSignatures, threshold_);
        }
    }

    /**
     * @notice Updates the list of owners and the signature threshold.
     * @dev See {_setConfig}.
     */
    function setConfig(address[] calldata owners_, uint256 threshold_) external onlyFactory {
        _setConfig(owners_, threshold_);
    }

    /**
     * @notice Updates the claim whitelist.
     * @dev Adds or removes addresses from the whitelist based on the provided statuses.
     * @param accounts Array of addresses to update.
     * @param statuses Array of booleans (true = add, false = remove).
     */
    function setWhitelist(address[] calldata accounts, bool[] calldata statuses) external onlyFactory {
        if (accounts.length != statuses.length) {
            revert InvalidWhitelistUpdate(accounts.length, statuses.length);
        }

        for (uint256 i = 0; i < accounts.length; i++) {
            if (accounts[i] == address(0)) {
                revert InvalidWhitelistAddress(address(0));
            }

            if (statuses[i]) {
                if (_whitelist.add(accounts[i])) {
                    emit SetWhitelist(accounts[i], true);
                }
            } else {
                if (_whitelist.remove(accounts[i])) {
                    emit SetWhitelist(accounts[i], false);
                }
            }
        }
    }

    /**
     * @notice Transfers funds from multiple `DepositAccount` contracts to a specified recipient.
     * @dev Uses the provided token address for all claims.
     * @param erc20 The address of the ERC20 token to collect from each `DepositAccount`.
     * @param to The address of the recipient.
     * @param accountIds An array of IDs of the accounts used to compute `DepositAccount` addresses.
     */
    function claimTo(address erc20, address to, bytes32[] calldata accountIds) external nonReentrant onlyFactory {
        for (uint256 i = 0; i < accountIds.length; i++) {
            _claim(erc20, to, accountIds[i]);
        }
    }

    /**
     * @notice Transfers funds from multiple `DepositAccount` contracts to this wallet.
     * @dev Uses the provided token address for all claims.
     * @param erc20 The address of the ERC20 token to collect from each `DepositAccount`.
     * @param accountIds An array of IDs of the accounts used to compute `DepositAccount` addresses.
     */
    function claim(address erc20, bytes32[] calldata accountIds) external nonReentrant onlyOwnerOrWhitelisted {
        for (uint256 i = 0; i < accountIds.length; i++) {
            _claim(erc20, address(this), accountIds[i]);
        }
    }

    /**
     * @dev Executes a batch of function calls in a single transaction with multisig authorization.
     * @notice Requires a valid number of unique signatures from authorized owners for operations.
     *
     * @param operations An array of operations.
     * @return results An array of bytes returned from each executed operation.
     */
    function execute(Operation[] calldata operations) external returns (bytes[][] memory results) {
        results = new bytes[][](operations.length);

        for (uint256 i = 0; i < operations.length; i++) {
            results[i] = _execute(operations[i].calls, operations[i].signatures, operations[i].id);
        }
    }

    /**
     * @dev Executes a batch of function calls in a single transaction with multisig authorization.
     * @notice Requires a valid number of unique signatures from authorized owners.
     *
     * @param calls An array of function call data to be executed on any contract.
     * @param signatures Packed ECDSA signatures approving the batch call, signed over the deterministic digest.
     * @param id The ID of the operation.
     * @return results An array of bytes returned from each executed function call.
     *
     * Requirements:
     * - Length of signatures must be sufficient to meet threshold
     * - Each signature must be from a valid owner
     * - No duplicate signatures allowed
     * - All encoded function calls can be to any contract
     *
     * Emits an {ExecuteSuccess} event with the current nonce
     *
     * @custom:security
     * - Uses nonce to prevent replay attacks
     * - Verifies signatures using EIP-712 standard
     * - Implements threshold signature scheme
     * - All operations are atomic (revert on any failure)
     */
    function _execute(
        Call[] calldata calls,
        bytes calldata signatures,
        bytes32 id
    ) internal returns (bytes[] memory results) {
        bytes32[] memory callHashes = new bytes32[](calls.length);

        for (uint256 i = 0; i < calls.length; i++) {
            callHashes[i] = keccak256(abi.encode(CALL_TYPEHASH, calls[i].to, calls[i].value, keccak256(calls[i].data)));
        }

        bytes32 callsHash = keccak256(abi.encodePacked(callHashes));

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(EXECUTE_TYPEHASH, callsHash, _nonce++)));

        this.checkSignatures(digest, signatures);

        results = new bytes[](calls.length);

        for (uint256 i = 0; i < calls.length; i++) {
            if (calls[i].to != address(0) && calls[i].value > 0 && calls[i].data.length == 0) {
                Address.sendValue(payable(calls[i].to), calls[i].value);
            } else {
                results[i] = Address.functionCallWithValue(calls[i].to, calls[i].data, calls[i].value);
            }
        }

        emit ExecuteSuccess(_nonce - 1, digest, id);
    }

    /**
     * @notice Updates `owners` with `threshold`.
     * @param owners_ List of owners.
     * @param threshold_ Number of required confirmations for transaction.
     */
    function _setConfig(
        address[] calldata owners_,
        uint256 threshold_
    ) internal validRequirements(owners_.length, threshold_) {
        // Clear the existing owners
        uint256 len = _owners.length();
        for (uint256 i = 0; i < len; i++) {
            address value = _owners.at(0);
            _owners.remove(value);
        }

        for (uint256 i = 0; i < owners_.length; i++) {
            address owner = owners_[i];
            if (owner == address(0) || owner == address(this)) {
                revert InvalidOwner(owner);
            }

            // Verify contract owners implement ERC-1271
            if (owner.code.length > 0) {
                (bool success, bytes memory result) = owner.staticcall(
                    abi.encodeWithSelector(IERC1271.isValidSignature.selector, bytes32(0), "")
                );
                if ((!success && result.length == 0) || (success && result.length < MIN_RESULT_LENGTH)) {
                    revert InvalidOwner(owner);
                }
            }

            if (!_owners.add(owner)) {
                revert DuplicateOwner(owner);
            }
        }

        _threshold = threshold_;

        emit SetConfig(msg.sender, _owners.length(), _threshold);
    }

    /**
     * @dev Deploys `DepositAccount` contract at a computed address using `CREATE2` and transfer funds.
     * Only callable internally to ensure controlled deployment of `DepositAccount` contracts.
     *
     * Emits a {Claim} event upon successful deployment and fund collection.
     *
     * @param token_ The address of the token to transfer. 0х0 to transfer only ETH.
     * @param recipient_ The address of the recipient.
     * @param accountId The ID of the account.
     */
    function _claim(address token_, address recipient_, bytes32 accountId) internal {
        if (recipient_ == address(0)) {
            revert InvalidRecipient(address(0));
        }

        _token = token_;
        _recipient = recipient_;

        (bytes memory bytecode, address account) = getAccount(accountId);

        uint256 ethAmount = account.balance;

        uint256 tokenAmount = 0;
        if (token_ != address(0)) {
            tokenAmount = IERC20(token_).balanceOf(account);
        }

        address deposit = Create2.deploy(0, accountId, bytecode);

        if (deposit != account) {
            revert FailedDeployment();
        }

        emit Claim(recipient_, account, token_, tokenAmount, ethAmount);

        _token = address(0);
        _recipient = address(0);
    }
}
