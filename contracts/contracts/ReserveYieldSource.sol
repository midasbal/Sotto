// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IYieldSource} from "./IYieldSource.sol";
import {ConfidentialTestUSD} from "./ConfidentialTestUSD.sol";

/// @title ReserveYieldSource
/// @notice An {IYieldSource} backed by an operator-funded tUSD reserve that accrues
/// linearly over time and pays out as ctUSD. Principal never enters this contract; it
/// holds only the prize reserve.
/// @dev On a testnet, the reserve is funded by the operator via {fund} rather than
/// earned, since there is no real external yield strategy to plug in yet. A real
/// external yield source (a lending market, an LP position, a staking vault) would
/// implement this same {IYieldSource} interface while actually generating the funds
/// it pays out, with no change required on the consuming side.
contract ReserveYieldSource is IYieldSource, Ownable {
    using SafeERC20 for IERC20;

    /// @notice The plaintext reserve asset (tUSD) this contract holds and accrues.
    IERC20 public immutable underlying;

    /// @notice The confidential wrapper prizes are delivered through.
    ConfidentialTestUSD public immutable wrapper;

    /// @notice The per-second accrual rate, scaled by 1e18.
    /// @dev Intended to be configured before, or between, accrual windows: {harvest}
    /// applies the rate in effect at harvest time across the entire elapsed window
    /// since the last accrual, not a time-weighted average of rates that changed
    /// mid-window.
    uint256 public rate;

    /// @notice The timestamp accrual is currently measured from.
    uint256 public lastAccrual;

    /// @notice The sole address authorized to call {harvest} (the pool, in a later
    /// phase).
    address public consumer;

    /// @dev `caller` called {harvest} but is not the authorized {consumer}.
    error UnauthorizedConsumer(address caller);

    /// @param underlying_ The plaintext reserve asset (tUSD).
    /// @param wrapper_ The confidential wrapper (ctUSD) prizes are delivered through.
    /// @param initialOwner The address authorized to fund the reserve and configure it.
    constructor(IERC20 underlying_, ConfidentialTestUSD wrapper_, address initialOwner) Ownable(initialOwner) {
        underlying = underlying_;
        wrapper = wrapper_;
        lastAccrual = block.timestamp;
    }

    /// @notice Pulls `amount` of tUSD from the caller into the reserve.
    /// @dev The reserve is simply this contract's tUSD balance; no separate accounting
    /// variable is kept for it.
    /// @param amount The amount of tUSD to pull from the owner and add to the reserve.
    function fund(uint256 amount) external onlyOwner {
        underlying.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Sets the per-second accrual rate.
    /// @param ratePerSecondScaled1e18 The new rate, scaled by 1e18.
    function setRate(uint256 ratePerSecondScaled1e18) external onlyOwner {
        rate = ratePerSecondScaled1e18;
    }

    /// @notice Sets the sole address authorized to call {harvest}.
    /// @param consumer_ The new authorized consumer.
    function setConsumer(address consumer_) external onlyOwner {
        consumer = consumer_;
    }

    /// @inheritdoc IYieldSource
    function pendingPrize(uint256 principalBasis) external view returns (uint256 prize) {
        return _cappedPrize(principalBasis);
    }

    /// @inheritdoc IYieldSource
    /// @dev The prize is delivered as a plaintext-amount wrap, so the harvested
    /// amount is public: a jackpot is meant to be advertised, not hidden. This is
    /// intended, not a leak.
    function harvest(address recipient, uint256 principalBasis) external returns (uint256 prize) {
        if (msg.sender != consumer) revert UnauthorizedConsumer(msg.sender);

        prize = _cappedPrize(principalBasis);
        lastAccrual = block.timestamp;

        underlying.forceApprove(address(wrapper), prize);
        wrapper.wrap(recipient, prize);
    }

    /// @dev Computes the prize accrued since {lastAccrual} for `principalBasis`,
    /// capped at both the current reserve balance and `type(uint64).max` so the
    /// subsequent confidential mint in {wrapper} can never overflow a `euint64`.
    function _cappedPrize(uint256 principalBasis) private view returns (uint256) {
        uint256 accrued = (principalBasis * rate * (block.timestamp - lastAccrual)) / 1e18;
        uint256 reserveBalance = underlying.balanceOf(address(this));
        return Math.min(Math.min(accrued, reserveBalance), type(uint64).max);
    }
}
