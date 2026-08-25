// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title IYieldSource
/// @notice Pluggable interface for the funding source behind a prize draw. An
/// implementation accrues a plaintext prize over time against the pool's aggregate
/// principal and delivers it confidentially when harvested.
/// @dev `principalBasis` is the aggregate pool total: a plaintext value, since it is
/// only ever revealed at draw time by the draw mechanism itself (a later phase), not
/// something this interface exposes on its own. This interface makes no assumption
/// about how a prize is actually generated: an operator-funded testnet reserve and a
/// real external yield strategy can both implement it identically.
interface IYieldSource {
    /// @notice Returns the prize that would be harvested right now for a given
    /// principal basis, without changing any state.
    /// @param principalBasis The aggregate pool total to accrue the prize against.
    /// @return prize The plaintext amount that {harvest} would currently deliver.
    function pendingPrize(uint256 principalBasis) external view returns (uint256 prize);

    /// @notice Accrues and delivers the current prize as confidential tokens to
    /// `recipient`, then resets the accrual clock.
    /// @param recipient The address to receive the harvested prize confidentially.
    /// @param principalBasis The aggregate pool total to accrue the prize against.
    /// @return prize The plaintext amount that was harvested and delivered.
    function harvest(address recipient, uint256 principalBasis) external returns (uint256 prize);
}
