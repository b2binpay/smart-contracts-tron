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

import {MultiSigWallet} from "../MultiSigWallet.sol";

/**
 * @dev TVM staking extension of {MultiSigWallet}.
 *
 *      Adds Stake 2.0 (freeze / unfreeze / cancel / withdraw), resource
 *      delegation (delegate / undelegate) and Super Representative voting
 *      (vote / withdrawReward / pendingReward) entry points on top of the
 *      EVM-aligned {MultiSigWallet} base. Every entry point here is gated by
 *      the multisig `execute()` flow via the inherited `onlyFactory` modifier,
 *      except the two delegation calls, which an address holding the matching
 *      permission may also call directly.
 *
 *      The base contract stays byte-for-byte aligned with the EVM repository
 *      so updates can be synced in cleanly; TVM-only additions live here and
 *      this is the contract deployed as the proxy-factory implementation on
 *      TRON.
 */
contract MultiSigWalletStaking is MultiSigWallet {
    error InvalidResourceType(uint256 resourceType);
    error InvalidVoteData(uint256 srCount, uint256 amountCount);

    /**
     * @dev Emitted when TRX is frozen via Stake 2.0 to gain `resourceType` (0 = bandwidth, 1 = energy).
     */
    event FreezeBalanceV2(uint256 amount, uint256 indexed resourceType);

    /**
     * @dev Emitted when TRX is unfrozen via Stake 2.0; the unfrozen amount enters the maturation queue.
     */
    event UnfreezeBalanceV2(uint256 amount, uint256 indexed resourceType);

    /**
     * @dev Emitted when all pending unfreeze entries are cancelled and re-frozen.
     */
    event CancelAllUnfreezeV2();

    /**
     * @dev Emitted after withdrawing matured unfrozen TRX.
     */
    event WithdrawExpireUnfreeze(uint256 amount);

    /**
     * @dev Emitted when resource is delegated to a receiver.
     */
    event DelegateResource(address indexed receiver, uint256 amount, uint256 indexed resourceType);

    /**
     * @dev Emitted when delegated resource is reclaimed from a receiver.
     */
    event UndelegateResource(address indexed receiver, uint256 amount, uint256 indexed resourceType);

    /**
     * @dev Emitted when votes are cast for a list of Super Representatives.
     *      Full SR list and per-SR amounts are recoverable from the originating
     *      `execute()` calldata; we only log fixed-size aggregates to save gas.
     */
    event VoteCast(uint256 srCount, uint256 totalTronPower);

    /**
     * @dev Emitted when accumulated SR voting reward is withdrawn.
     */
    event WithdrawReward(uint256 amount);

    // TVM Stake 2.0 resource types
    uint256 public constant RESOURCE_BANDWIDTH = 0;
    uint256 public constant RESOURCE_ENERGY = 1;

    /**
     * @dev The permissions this chain adds to {MultiSigWalletPermissions-supportedPermissions}, allocated
     *      above {MultiSigWalletPermissions-BASE_PERMISSION_MASK} so a permission the base adds later
     *      cannot take a bit a wallet already stores here. Each one gates a resource entry point below;
     *      resource delegation is a TVM Stake 2.0 operation and has no counterpart on an EVM chain. Their
     *      union is not published as a constant of its own: `supportedPermissions() & ~BASE_PERMISSION_MASK`
     *      already answers what this extension adds, and reading it that way covers the hook instead of a
     *      parallel declaration.
     */
    uint256 public constant PERMISSION_DELEGATE = 1 << 128;
    uint256 public constant PERMISSION_UNDELEGATE = 1 << 129;

    /**
     * @dev Reverts with {InvalidResourceType} if `resourceType` is neither
     *      {RESOURCE_BANDWIDTH} (0) nor {RESOURCE_ENERGY} (1).
     */
    modifier validResourceType(uint256 resourceType) {
        if (resourceType > RESOURCE_ENERGY) {
            revert InvalidResourceType(resourceType);
        }
        _;
    }

    /**
     * @notice Freezes (stakes) `amount` SUN of TRX for `resourceType` via TVM Stake 2.0.
     * @dev Wraps TRON-Solidity global `freezebalancev2`. Gated by multisig.
     *      `resourceType`: 0 = bandwidth, 1 = energy.
     */
    function freezeBalanceV2(
        uint256 amount,
        uint256 resourceType
    ) external onlyFactory validResourceType(resourceType) {
        freezebalancev2(amount, resourceType);
        emit FreezeBalanceV2(amount, resourceType);
    }

    /**
     * @notice Initiates an unfreeze of `amount` SUN of `resourceType` (Stake 2.0).
     * @dev Wraps TRON-Solidity global `unfreezebalancev2`. Unfrozen TRX enters a 14-day
     *      maturation queue and is withdrawable via {withdrawExpireUnfreeze}.
     */
    function unfreezeBalanceV2(
        uint256 amount,
        uint256 resourceType
    ) external onlyFactory validResourceType(resourceType) {
        unfreezebalancev2(amount, resourceType);
        emit UnfreezeBalanceV2(amount, resourceType);
    }

    /**
     * @notice Cancels all pending unfreeze entries and re-stakes them.
     * @dev Wraps TRON-Solidity global `cancelallunfreezev2`.
     */
    function cancelAllUnfreezeV2() external onlyFactory {
        cancelallunfreezev2();
        emit CancelAllUnfreezeV2();
    }

    /**
     * @notice Withdraws all matured unfrozen TRX back to this wallet's balance.
     * @dev Wraps TRON-Solidity global `withdrawexpireunfreeze`. Returns matured amount in SUN.
     */
    function withdrawExpireUnfreeze() external onlyFactory returns (uint256 amount) {
        amount = withdrawexpireunfreeze();
        emit WithdrawExpireUnfreeze(amount);
    }

    /**
     * @notice Delegates `amount` SUN of `resourceType` to `receiver`.
     * @dev Wraps TRON-Solidity member `address.delegateResource`. Reachable through `execute()` or by
     *      an address holding `PERMISSION_DELEGATE`; owner status alone does not authorize a direct call.
     */
    function delegateResource(
        uint256 amount,
        address payable receiver,
        uint256 resourceType
    ) external onlyFactoryOrPermitted(PERMISSION_DELEGATE) validResourceType(resourceType) {
        if (receiver == address(0)) {
            revert InvalidRecipient(address(0));
        }
        receiver.delegateResource(amount, resourceType);
        emit DelegateResource(receiver, amount, resourceType);
    }

    /**
     * @notice Reclaims `amount` SUN of `resourceType` previously delegated to `receiver`.
     * @dev Wraps TRON-Solidity member `address.unDelegateResource`. Reachable through `execute()` or by
     *      an address holding `PERMISSION_UNDELEGATE`; owner status alone does not authorize a direct call.
     */
    function undelegateResource(
        uint256 amount,
        address payable receiver,
        uint256 resourceType
    ) external onlyFactoryOrPermitted(PERMISSION_UNDELEGATE) validResourceType(resourceType) {
        if (receiver == address(0)) {
            revert InvalidRecipient(address(0));
        }
        receiver.unDelegateResource(amount, resourceType);
        emit UndelegateResource(receiver, amount, resourceType);
    }

    /**
     * @notice Casts votes from this wallet's TronPower across the given Super Representatives.
     * @dev Wraps TRON-Solidity global `vote`. Replaces previous votes (TRON semantics).
     *      `srs` and `tronPowerAmounts` must be the same length. Sum must not exceed
     *      this wallet's available TronPower; otherwise the TVM call reverts.
     *      Empty arrays / zero addresses / duplicates are passed through to the
     *      protocol-level `VoteWitnessContract`, which defines the canonical behavior.
     */
    function voteWitnesses(
        address[] calldata srs,
        uint256[] calldata tronPowerAmounts
    ) external onlyFactory {
        if (srs.length != tronPowerAmounts.length) {
            revert InvalidVoteData(srs.length, tronPowerAmounts.length);
        }
        vote(srs, tronPowerAmounts);
        uint256 total;
        for (uint256 i = 0; i < tronPowerAmounts.length; i++) {
            total += tronPowerAmounts[i];
        }
        emit VoteCast(srs.length, total);
    }

    /**
     * @notice Withdraws accumulated SR voting reward to this wallet's TRX balance.
     * @dev Wraps TRON-Solidity global `withdrawreward`. Returns claimed amount in SUN.
     */
    function withdrawReward() external onlyFactory returns (uint256 amount) {
        amount = withdrawreward();
        emit WithdrawReward(amount);
    }

    /**
     * @notice Returns the unclaimed SR voting reward in SUN.
     * @dev Wraps TRON-Solidity global `rewardBalance`. View — no auth required.
     */
    function pendingReward() public view returns (uint256) {
        return rewardBalance();
    }

    /**
     * @dev See {MultiSigWalletPermissions-_extensionPermissions}. Both bits gate a resource entry point above, so the
     *      set this returns is exactly what a mask can hold here beyond the base permissions.
     */
    function _extensionPermissions() internal pure override returns (uint256) {
        return PERMISSION_DELEGATE | PERMISSION_UNDELEGATE;
    }
}
