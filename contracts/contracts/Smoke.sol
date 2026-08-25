// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title Smoke
/// @notice Phase-0 toolchain smoke test: proves encrypted input, storage, ACL, and
/// user decryption all work end to end in this repo. To be removed once real
/// contracts land.
contract Smoke is ZamaEthereumConfig {
    euint64 private _value;

    /// @notice Validates an encrypted input and stores it, granting the caller and
    /// this contract decrypt access.
    /// @param value The encrypted value to store.
    /// @param inputProof The zero-knowledge proof attesting to `value`.
    function store(externalEuint64 value, bytes calldata inputProof) external {
        euint64 validated = FHE.fromExternal(value, inputProof);
        FHE.allowThis(validated);
        FHE.allow(validated, msg.sender);
        _value = validated;
    }

    /// @notice Returns the stored encrypted value's handle.
    /// @return value The stored encrypted value.
    function get() external view returns (euint64 value) {
        return _value;
    }
}
