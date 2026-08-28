// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

/**
 * @title IFactory
 * @dev Interface for Factory contract.
 */
interface IFactory {
    /**
     * @dev The caller account is not authorized to perform an operation.
     */
    error UnauthorizedAccount(address account);

    /**
     * @dev Indicates a failure with the `recipient` for `claim` operation.
     * @param recipient Address to which tokens are being transferred.
     */
    error InvalidRecipient(address recipient);

    /**
     * @dev Indicates an array length mismatch between recipients and accountIds in a `getAccounts` operation.
     * Used in batch transfers.
     * @param recipients Length of the array of token identifiers
     * @param accountIds Length of the array of token amounts
     */
    error InvalidArrayLength(uint256 recipients, uint256 accountIds);

    /**
     * @dev The deployment failed.
     */
    error FailedDeployment();

    /**
     * @dev Emitted when a deposit contract has been successfully deployed and funds are claimed.
     * @param recipient Address to which the funds are sent.
     * @param deposit Address of the deployed Deposit contract.
     * @param token ERC20 address.
     * @param tokenAmount Amount of ERC20 collected from the deposit contract.
     * @param ethAmount Amount of Ether collected from the deposit contract.
     */
    event Claim(address indexed recipient, address deposit, address token, uint256 tokenAmount, uint256 ethAmount);

    /**
     * @dev Returns the current recipient address for funds.
     * @return The address that will receive the funds from Deposit contracts.
     */
    function recipient() external view returns (address);

    /**
     * @dev Returns the address of the current token for deposit operations.
     * @return The address of the token being used for the current transaction.
     */
    function token() external view returns (address);

    /**
     * @dev Returns the version of the Factory contract.
     * @return The version of the Factory contract as a string.
     */
    function version() external pure returns (string memory);
}
