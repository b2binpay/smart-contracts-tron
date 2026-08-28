// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {ERC20} from "../token/ERC20/ERC20.sol";

contract ERC20Mock is ERC20 {
    address private _owner = msg.sender;

    constructor(string memory name, string memory symbol, uint256 initialSupply) ERC20(name, symbol) {
        _mint(_owner, initialSupply);
    }

    function owner() public view returns (address) {
        return _owner;
    }
}
