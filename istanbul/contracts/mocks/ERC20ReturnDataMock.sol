// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

/**
 * @dev Configurable ERC-20 stub for exercising every `transfer` returndata shape handled by SafeERC20Minimal.
 * The return payload and the actual balance effect are controlled independently, so tests can combine any
 * returndata with any debit outcome. `transfer` is declared without a return value on purpose — the payload
 * is produced directly in assembly.
 */
contract ERC20ReturnDataMock {
    enum ReturnMode {
        True, // 32 bytes, value 1
        Empty, // no return data
        False, // 32 bytes, value 0
        Two, // 32 bytes, value 2
        Short, // a single byte
        Long // 64 bytes, first word 1
    }

    enum TransferEffect {
        Full, // debit the sender by the full value
        Partial, // debit the sender by half of the value
        None, // keep balances untouched
        Credit // credit the sender instead of debiting
    }

    ReturnMode public returnMode;
    TransferEffect public transferEffect;

    mapping(address => uint256) public balanceOf;

    function setBehavior(ReturnMode returnMode_, TransferEffect transferEffect_) external {
        returnMode = returnMode_;
        transferEffect = transferEffect_;
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function transfer(address to, uint256 value) external {
        if (transferEffect == TransferEffect.Full) {
            balanceOf[msg.sender] -= value;
            balanceOf[to] += value;
        } else if (transferEffect == TransferEffect.Partial) {
            uint256 half = value / 2;
            balanceOf[msg.sender] -= half;
            balanceOf[to] += half;
        } else if (transferEffect == TransferEffect.Credit) {
            balanceOf[msg.sender] += value;
        }

        ReturnMode mode = returnMode;

        assembly ("memory-safe") {
            switch mode
            case 0 {
                mstore(0x00, 1)
                return(0x00, 0x20)
            }
            case 1 {
                return(0x00, 0x00)
            }
            case 2 {
                mstore(0x00, 0)
                return(0x00, 0x20)
            }
            case 3 {
                mstore(0x00, 2)
                return(0x00, 0x20)
            }
            case 4 {
                mstore8(0x00, 1)
                return(0x00, 0x01)
            }
            case 5 {
                mstore(0x00, 1)
                mstore(0x20, 1)
                return(0x00, 0x40)
            }
        }
    }
}
