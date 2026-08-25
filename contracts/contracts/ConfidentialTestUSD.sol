// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title ConfidentialTestUSD
/// @notice Confidential ERC-7984 wrapper around {TestUSD}. This is the public
/// wrap/unwrap boundary: wrapping public tUSD mints confidential ctUSD one-to-one,
/// and unwrapping burns ctUSD to release the underlying tUSD back.
/// @dev Wrap and unwrap are, by design, the one place a token amount is public on
/// this asset's path: the ERC-20 `transferFrom` on wrap and the `finalizeUnwrap`
/// payout on unwrap both move a plaintext amount of the underlying token. This is
/// kept deliberately separate from pool deposits and withdrawals, which move only
/// confidential ctUSD and never touch this public boundary.
contract ConfidentialTestUSD is ERC7984ERC20Wrapper, ZamaEthereumConfig {
    constructor(
        IERC20 underlying_
    ) ERC7984("Confidential Test USD", "ctUSD", "") ERC7984ERC20Wrapper(underlying_) {}
}
