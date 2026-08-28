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

import {IFactory} from "./interfaces/IFactory.sol";
import {EnumerableSet} from "./utils/structs/EnumerableSet.sol";

/**
 * @dev The permission model shared by every multisig deployment: one packed mask per address, a delta
 *      setter, and a bit range reserved for chain-specific extensions. Inherited by the wallet, so the
 *      permissions live in one file while every gate, view and mask stays part of the same runtime
 *      contract. The gates here reject through {IFactory-UnauthorizedAccount}, so an inheritor shares that
 *      error dictionary.
 */
abstract contract MultiSigWalletPermissions {
    using EnumerableSet for EnumerableSet.AddressSet;

    error InvalidPermissionUpdate(uint256 accounts, uint256 grants, uint256 revokes);
    error InvalidPermissionAccount(address account);
    error UnsupportedPermissions(uint256 permissions);
    error ConflictingPermissions(uint256 grants, uint256 revokes);
    error InvalidExtensionPermissions(uint256 permissions);

    /**
     * @dev Emitted when the permission mask stored for `account` changes.
     *      Both masks are carried so an indexer reconstructs the delta without holding prior state.
     * @param account The account whose permissions changed.
     * @param oldPermissions The mask before the update.
     * @param newPermissions The mask after the update; `0` means the account left the enumeration index.
     */
    event PermissionsChanged(address indexed account, uint256 oldPermissions, uint256 newPermissions);

    /**
     * @dev Every permission is a single bit, so one mask per address carries all of them. A base permission
     *      belongs here when the wallet itself gates it rather than a chain-specific extension:
     *      `PERMISSION_CLAIM` is gated by {MultiSigWallet-claim}.
     */
    uint256 public constant PERMISSION_CLAIM = 1 << 0;

    /**
     * @dev Bits `0..127` belong to the shared base: a permission declared here means the same thing on every
     *      chain. A chain-specific extension allocates from bit `128` upward, so a permission the base adds
     *      later can never collide with a bit an extension already stores. Public so integrations and the
     *      tests of a chain-specific extension take the boundary as a value instead of hardcoding it.
     */
    uint256 public constant BASE_PERMISSION_MASK = type(uint128).max;

    // Enumeration index over every address holding a non-zero permission mask
    EnumerableSet.AddressSet private _permissionAccounts;

    // Permission mask granted to an address by the multisig; `0` means the address holds no permissions
    mapping(address => uint256) private _permissions;

    /**
     * @dev Restricts function calls to the factory contract itself and to addresses holding `permission`.
     *      Owner status alone never passes: an owner reaches the function through {MultiSigWallet-execute},
     *      or by holding a permission granted the same way as for any other address.
     * @param permission A declared permission bit. A mask of several bits requires the account to hold
     *        all of them.
     */
    modifier onlyFactoryOrPermitted(uint256 permission) {
        if (msg.sender != address(this) && !_permitted(msg.sender, permission)) {
            revert IFactory.UnauthorizedAccount(msg.sender);
        }
        _;
    }

    /**
     * @notice Returns the permission mask stored for `account`.
     * @return The exact stored mask, or `0` if `account` holds no permissions.
     */
    function permissionsOf(address account) public view returns (uint256) {
        return _permissions[account];
    }

    /**
     * @notice Returns if `account` holds every permission in `permission`.
     * @dev Returns `false` for an empty `permission` and for one carrying bits outside
     *      {supportedPermissions}, without reverting: views feed multicall reads, where a revert turns one bad
     *      argument into a failed batch, and `(mask & 0) == 0` would otherwise report `true` for every address.
     * @param permission One or several permission bits.
     * @return Boolean if every requested bit is present in the stored mask.
     */
    function hasPermission(address account, uint256 permission) public view returns (bool) {
        if ((permission & ~supportedPermissions()) != 0) {
            return false;
        }

        return _permitted(account, permission);
    }

    /**
     * @notice Returns every account holding a permission, with its mask.
     * @dev Indices of the two arrays correspond; the order is not part of the interface. A caller after one
     *      group filters the masks it reads here — the addresses allowed to call {MultiSigWallet-claim} are
     *      the ones whose mask carries `PERMISSION_CLAIM`.
     * @return accounts Addresses holding a non-zero mask.
     * @return masks The mask stored for the address at the same index.
     */
    function permissions() public view returns (address[] memory accounts, uint256[] memory masks) {
        accounts = _permissionAccounts.values();
        masks = new uint256[](accounts.length);

        for (uint256 i = 0; i < accounts.length; i++) {
            masks[i] = _permissions[accounts[i]];
        }
    }

    /**
     * @notice Returns the permissions this deployment enforces.
     * @dev The single authority for what a mask may hold here: {_updatePermissions} rejects any bit
     *      outside it and {hasPermission} reports `false` for one, so no bit can sit in storage waiting for a
     *      future release to give it meaning. Not virtual — an extension supplies its own bits through
     *      {_extensionPermissions}, so the base permissions are part of every deployment's set by
     *      construction and a permission added to the composition here is enforced on every chain.
     * @return The mask of enforced permissions.
     */
    function supportedPermissions() public pure returns (uint256) {
        return PERMISSION_CLAIM | _extensionPermissions();
    }

    /**
     * @dev Rejects a deployment whose extension permissions reach into the base range, so a misallocation is
     *      caught on the first clone rather than by whoever later reads a mask it collides with. The bits are
     *      not masked off: a permission dropped here would leave its entry point unreachable with no trace of
     *      why. The call belongs in the inheritor's initializer — {MultiSigWallet-setup} makes it — since a
     *      `pure` check cannot enforce its own call site.
     */
    function _assertExtensionPermissions() internal pure {
        uint256 extensionPermissions = _extensionPermissions();

        if ((extensionPermissions & BASE_PERMISSION_MASK) != 0) {
            revert InvalidExtensionPermissions(extensionPermissions);
        }
    }

    /**
     * @dev Applies a delta per entry: `newMask = (oldMask | grants[i]) & ~revokes[i]`. The masks are relative
     *      and not absolute, so two operations signed against the same earlier state and executed in either
     *      order cannot erase each other's unrelated permissions — only a grant and a revoke of the same bit
     *      remain order-dependent. Duplicate accounts in one batch apply sequentially. An entry that leaves
     *      the mask unchanged emits nothing, and a mask reaching `0` leaves the enumeration index.
     * @param accounts Array of addresses to update.
     * @param grants Array of permission masks to add, one per account.
     * @param revokes Array of permission masks to remove, one per account.
     */
    function _updatePermissions(
        address[] calldata accounts,
        uint256[] calldata grants,
        uint256[] calldata revokes
    ) internal {
        if (accounts.length != grants.length || accounts.length != revokes.length) {
            revert InvalidPermissionUpdate(accounts.length, grants.length, revokes.length);
        }

        uint256 supported = supportedPermissions();

        for (uint256 i = 0; i < accounts.length; i++) {
            address account = accounts[i];
            if (account == address(0)) {
                revert InvalidPermissionAccount(address(0));
            }

            uint256 granted = grants[i];
            uint256 revoked = revokes[i];

            if ((granted & ~supported) != 0) {
                revert UnsupportedPermissions(granted);
            }

            if ((revoked & ~supported) != 0) {
                revert UnsupportedPermissions(revoked);
            }

            if ((granted & revoked) != 0) {
                revert ConflictingPermissions(granted, revoked);
            }

            uint256 oldPermissions = _permissions[account];
            uint256 newPermissions = (oldPermissions | granted) & ~revoked;

            if (newPermissions == oldPermissions) {
                continue;
            }

            _permissions[account] = newPermissions;

            if (oldPermissions == 0) {
                _permissionAccounts.add(account);
            } else if (newPermissions == 0) {
                _permissionAccounts.remove(account);
            }

            emit PermissionsChanged(account, oldPermissions, newPermissions);
        }
    }

    /**
     * @dev Checks the stored mask of `account` against `permission` for the access modifiers, which pass a
     *      declared constant. An empty `permission` never passes, so a modifier applied with `0` closes the
     *      function instead of opening it to everyone. {hasPermission} wraps this for external callers,
     *      whose argument may also carry unsupported bits.
     * @param account The account whose mask is checked.
     * @param permission One or several permission bits.
     * @return Boolean if `permission` is non-empty and every requested bit is present.
     */
    function _permitted(address account, uint256 permission) internal view returns (bool) {
        return permission != 0 && (_permissions[account] & permission) == permission;
    }

    /**
     * @dev The permissions a chain-specific extension adds to {supportedPermissions}, allocated above
     *      {BASE_PERMISSION_MASK}. Every returned permission MUST gate an entry point on that deployment:
     *      {_assertExtensionPermissions} rejects one inside the base range and {_updatePermissions} keeps an
     *      undeclared bit out of storage, but neither can verify that a declared bit has a gate behind it.
     * @return The mask of extension permissions, empty on a deployment that adds none.
     */
    function _extensionPermissions() internal pure virtual returns (uint256) {
        return 0;
    }
}
