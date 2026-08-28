// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

contract Migrations {
    // Custom error for gas optimization
    error RestrictedToOwner();

    address public owner;
    uint256 public lastCompletedMigration;

    modifier restricted() {
        if (msg.sender != owner) revert RestrictedToOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setCompleted(uint256 completed) public restricted {
        lastCompletedMigration = completed;
    }

    function upgrade(address newAddress) public restricted {
        Migrations upgraded = Migrations(newAddress);
        upgraded.setCompleted(lastCompletedMigration);
    }
}