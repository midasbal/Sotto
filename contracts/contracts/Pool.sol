// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, ebool, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {IERC7984Receiver} from "@openzeppelin/confidential-contracts/interfaces/IERC7984Receiver.sol";
import {FHESafeMath} from "@openzeppelin/confidential-contracts/utils/FHESafeMath.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Pool
/// @notice Confidential no-loss prize-savings pool core: custodies ctUSD, tracks an
/// encrypted per-depositor balance, and lets each depositor withdraw up to their full
/// principal at any time. No draw, no yield, no prizes, no admin controls; those are
/// later phases.
/// @dev Solvency invariant: the pool's own ctUSD balance is always at least the sum of
/// all depositors' encrypted balances (deposits credit exactly what was received;
/// withdrawals clamp to, and never exceed, the caller's own balance).
///
/// The depositor set is append-only by design: whether a withdrawal zeroed a balance
/// is itself encrypted, so the contract cannot branch on it to prune the set without
/// leaking that fact. Pruning is deferred to the draw phase, which will need to
/// iterate the set anyway and can decide then how to handle empty balances.
contract Pool is IERC7984Receiver, ReentrancyGuard, ZamaEthereumConfig {
    /// @notice The ctUSD confidential token this pool accepts deposits in and pays
    /// withdrawals out in.
    IERC7984 public immutable asset;

    /// @dev Encrypted principal balance credited to each depositor.
    mapping(address depositor => euint64 balance) private _balances;

    /// @dev Every address that has ever deposited, in first-deposit order. Append-only;
    /// see the contract-level note on why it is never pruned here.
    address[] private _depositors;

    /// @dev O(1) membership check backing `_depositors` so repeat deposits from the
    /// same address never create duplicate entries and so adding a depositor never
    /// requires iterating the array.
    mapping(address depositor => bool isMember) private _isDepositor;

    /// @notice Emitted when `depositor`'s encrypted balance is credited by a deposit.
    /// @dev `newBalance` is an FHE ciphertext handle, never a plaintext amount.
    event Deposited(address indexed depositor, euint64 newBalance);

    /// @notice Emitted when `depositor` withdraws from the pool.
    /// @dev `newBalance` is an FHE ciphertext handle, never a plaintext amount.
    event Withdrawn(address indexed depositor, euint64 newBalance);

    /// @dev A confidential-transfer-and-call hook was invoked by a contract other than
    /// `asset`.
    error UnauthorizedToken(address caller);

    /// @param asset_ The ctUSD confidential token this pool accepts deposits in and
    /// pays withdrawals out in.
    constructor(IERC7984 asset_) {
        asset = asset_;
    }

    /// @notice Confidential-transfer-and-call hook invoked by `asset` to atomically
    /// notify this pool of an incoming deposit.
    /// @dev Credits `from`'s encrypted balance with the confidential `amount` that
    /// `asset` has already moved into this contract, and adds `from` to the depositor
    /// set on first deposit. Returns {FHESafeMath-tryIncrease}'s own `success` flag
    /// rather than a hardcoded `true`, so that if a credit were ever to fail, `asset`
    /// would refund the depositor instead of silently swallowing the deposit.
    ///
    /// In practice this failure branch is unreachable, not merely untested: the ctUSD
    /// wrapper caps its confidential total supply at `type(uint64).max` (see
    /// {ERC7984ERC20Wrapper-maxTotalSupply}), so no single depositor's balance plus an
    /// incoming deposit can ever overflow a `euint64` add. This is defense in depth
    /// against that invariant changing upstream, not a path we can or should force
    /// open with a test backdoor.
    /// @param from The depositor whose tokens were transferred to this contract.
    /// @param amount The encrypted amount transferred to this contract by `asset`.
    /// @return accepted The encrypted result of the credit: `true` unless crediting
    /// `from`'s balance would overflow a `euint64`.
    function onConfidentialTransferReceived(
        address /* operator */,
        address from,
        euint64 amount,
        bytes calldata /* data */
    ) external override returns (ebool accepted) {
        if (msg.sender != address(asset)) revert UnauthorizedToken(msg.sender);

        _addDepositor(from);

        (ebool success, euint64 updated) = FHESafeMath.tryIncrease(_balances[from], amount);
        FHE.allowThis(updated);
        FHE.allow(updated, from);
        _balances[from] = updated;

        emit Deposited(from, updated);

        accepted = success;
        // `asset` needs ACL access to keep operating on this handle in its own
        // best-effort-refund `FHE.select` back in its execution context, and
        // ERC7984Utils.checkOnTransferReceived requires this contract itself to be
        // allowed on the value it returns.
        FHE.allowThis(accepted);
        FHE.allow(accepted, msg.sender);
    }

    /// @notice Withdraws up to `requestedAmount` of the caller's confidential balance,
    /// sending it back via a confidential transfer of `asset`.
    /// @dev The amount actually sent is clamped branchlessly to the caller's available
    /// balance with {FHE.select}: requesting at least the full balance returns exactly
    /// the full balance rather than reverting. No `require`/`revert` is ever gated on
    /// comparing encrypted values, since a revert that depends on whether the balance
    /// was sufficient would leak, via transaction success or failure, whether the
    /// caller could afford the requested amount. Storage is updated before the
    /// external call to `asset` (checks-effects-interactions).
    /// @param requestedAmount The encrypted amount the caller wishes to withdraw.
    /// @param inputProof The zero-knowledge proof attesting to `requestedAmount`.
    function withdraw(externalEuint64 requestedAmount, bytes calldata inputProof) external nonReentrant {
        euint64 requested = FHE.fromExternal(requestedAmount, inputProof);

        euint64 balance = _balances[msg.sender];
        if (!FHE.isInitialized(balance)) {
            balance = FHE.asEuint64(0);
        }

        euint64 amountToSend = FHE.select(FHE.le(requested, balance), requested, balance);
        euint64 remaining = FHE.sub(balance, amountToSend);

        FHE.allowThis(remaining);
        FHE.allow(remaining, msg.sender);
        _balances[msg.sender] = remaining;

        emit Withdrawn(msg.sender, remaining);

        FHE.allowThis(amountToSend);
        FHE.allow(amountToSend, address(asset));
        asset.confidentialTransfer(msg.sender, amountToSend);
    }

    /// @notice Returns the encrypted balance of `depositor`.
    /// @dev The returned value is an FHE ciphertext handle. Only `depositor` (and any
    /// account `depositor` separately grants access to) can user-decrypt it; that
    /// access control is enforced by the FHEVM coprocessor's ACL, not by this view
    /// function.
    /// @param depositor The address whose encrypted balance to return.
    /// @return balance The encrypted balance of `depositor`.
    function balanceOf(address depositor) external view returns (euint64 balance) {
        return _balances[depositor];
    }

    /// @notice Returns the number of unique addresses that have ever deposited.
    /// @return count The number of unique depositors.
    function depositorCount() external view returns (uint256 count) {
        return _depositors.length;
    }

    /// @notice Returns the depositor address at `index` in first-deposit order.
    /// @dev Intended for iteration by the later draw phase.
    /// @param index The index into the depositor set, in `[0, depositorCount())`.
    /// @return depositor The depositor address at `index`.
    function depositorAt(uint256 index) external view returns (address depositor) {
        return _depositors[index];
    }

    /// @dev Adds `depositor` to the depositor set if not already present. Membership
    /// is checked in O(1) via `_isDepositor`; the depositor array is never iterated to
    /// perform this check.
    /// @param depositor The address to add to the depositor set.
    function _addDepositor(address depositor) private {
        if (!_isDepositor[depositor]) {
            _isDepositor[depositor] = true;
            _depositors.push(depositor);
        }
    }
}
