// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSD
/// @notice Testnet-only 6-decimal ERC-20 with a built-in, rate-limited faucet. This is
/// the public underlying asset wrapped by {ConfidentialTestUSD}; it carries no value
/// and exists solely to fund test accounts on the FHEVM mock and, later, on Sepolia.
/// @dev Not audited for, and never intended for, mainnet use.
contract TestUSD is ERC20 {
    /// @notice Amount minted per faucet claim (10,000 tUSD, at 6 decimals). Tunable.
    uint256 public constant FAUCET_AMOUNT = 10_000 * 10 ** 6;

    /// @notice Minimum wait between faucet claims from the same address. Tunable.
    uint256 public constant FAUCET_COOLDOWN = 1 hours;

    /// @dev Timestamp of each address's most recent faucet claim.
    mapping(address account => uint256 lastClaimTimestamp) private _lastClaim;

    /// @dev `account` attempted to claim before its cooldown, which expires at `availableAt`.
    error FaucetCooldownActive(address account, uint256 availableAt);

    constructor() ERC20("Test USD", "tUSD") {}

    /// @notice Mints {FAUCET_AMOUNT} of tUSD to the caller, gated by {FAUCET_COOLDOWN}.
    /// @dev Reverts with {FaucetCooldownActive} if called again before the caller's
    /// cooldown has elapsed.
    function claim() external {
        uint256 availableAt = _lastClaim[msg.sender] + FAUCET_COOLDOWN;
        if (block.timestamp < availableAt) {
            revert FaucetCooldownActive(msg.sender, availableAt);
        }
        _lastClaim[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Returns the timestamp at which `account` may next call {claim}.
    /// @param account The address to query.
    /// @return availableAt The unix timestamp `account`'s cooldown expires at.
    function faucetAvailableAt(address account) external view returns (uint256 availableAt) {
        return _lastClaim[account] + FAUCET_COOLDOWN;
    }

    /// @inheritdoc ERC20
    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
