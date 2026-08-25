// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, ebool, euint64, euint128, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {IERC7984Receiver} from "@openzeppelin/confidential-contracts/interfaces/IERC7984Receiver.sol";
import {FHESafeMath} from "@openzeppelin/confidential-contracts/utils/FHESafeMath.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IYieldSource} from "./IYieldSource.sol";

/// @title Pool
/// @notice Confidential no-loss prize-savings pool: custodies ctUSD, tracks an
/// encrypted per-depositor balance, lets each depositor withdraw up to their full
/// principal at any time, and periodically runs a deposit-weighted prize draw funded
/// by an {IYieldSource}. No admin controls beyond the draw itself.
/// @dev Solvency invariant: the pool's own ctUSD balance is always at least the sum of
/// all depositors' encrypted balances (deposits credit exactly what was received;
/// withdrawals clamp to, and never exceed, the caller's own balance; a draw credits
/// exactly one winner with exactly the harvested prize).
///
/// The depositor set is append-only by design: whether a withdrawal zeroed a balance
/// is itself encrypted, so the contract cannot branch on it to prune the set without
/// leaking that fact. Pruning is deferred to a later phase.
///
/// Draw confidentiality: the only value ever revealed in plaintext is the aggregate
/// pool total, and only at draw time. Individual deposits, withdrawals, and balances
/// stay encrypted throughout, including through a draw: every depositor's balance
/// handle changes on every draw (credited with the prize if they won, with zero
/// otherwise), so the pattern of which handle changed cannot itself identify the
/// winner. The prize amount is intentionally public (a jackpot is meant to be
/// advertised); the winner's identity is not, and is knowable only to the winner, who
/// learns it by user-decrypting their own new balance.
///
/// This phase (4a) walks the full depositor set in a single transaction and does not
/// freeze deposits or withdrawals during a reveal window; both are accepted here as
/// this phase's known scope, deferred to a later chunked, freeze-aware phase.
contract Pool is IERC7984Receiver, ReentrancyGuard, ZamaEthereumConfig {
    /// @notice The lifecycle state of the draw.
    enum DrawState {
        Idle,
        Revealing
    }

    /// @notice The ctUSD confidential token this pool accepts deposits in and pays
    /// withdrawals and prizes out in.
    IERC7984 public immutable asset;

    /// @notice The yield source that funds the prize harvested at each draw.
    IYieldSource public immutable yieldSource;

    /// @notice The minimum time that must elapse between the start of one draw and
    /// the next.
    uint256 public immutable drawInterval;

    /// @dev Encrypted principal balance credited to each depositor.
    mapping(address depositor => euint64 balance) private _balances;

    /// @dev Encrypted sum of all depositor balances. Maintained incrementally on
    /// every deposit and withdrawal so that revealing it at draw time is O(1) rather
    /// than requiring a fresh summation over every depositor.
    euint64 private _totalDeposits;

    /// @dev Every address that has ever deposited, in first-deposit order. Append-only;
    /// see the contract-level note on why it is never pruned here.
    address[] private _depositors;

    /// @dev O(1) membership check backing `_depositors` so repeat deposits from the
    /// same address never create duplicate entries and so adding a depositor never
    /// requires iterating the array.
    mapping(address depositor => bool isMember) private _isDepositor;

    /// @notice The current draw lifecycle state.
    DrawState public drawState;

    /// @notice The timestamp the most recent draw was started at.
    uint256 public lastDraw;

    /// @dev The encrypted total snapshotted and marked publicly decryptable when the
    /// current reveal was started, verified against on {fulfillDraw}. Distinct from
    /// `_totalDeposits`, which may keep moving while a reveal is outstanding.
    euint64 private _revealingTotal;

    /// @notice Emitted when `depositor`'s encrypted balance is credited by a deposit.
    /// @dev `newBalance` is an FHE ciphertext handle, never a plaintext amount.
    event Deposited(address indexed depositor, euint64 newBalance);

    /// @notice Emitted when `depositor` withdraws from the pool.
    /// @dev `newBalance` is an FHE ciphertext handle, never a plaintext amount.
    event Withdrawn(address indexed depositor, euint64 newBalance);

    /// @notice Emitted when a draw reveal is started.
    /// @dev `total` is an FHE ciphertext handle, not a plaintext amount; it is the
    /// value that must be publicly decrypted and submitted to {fulfillDraw}.
    event DrawStarted(euint64 total);

    /// @notice Emitted once the winning dart has been drawn, before any balance is
    /// credited.
    /// @dev `dart` is an FHE ciphertext handle, not a plaintext value: it is never
    /// made publicly decryptable, so revealing the handle reveals nothing on chain.
    /// It exists purely so off-chain tooling (including tests, via a debug-only
    /// decrypt with no ACL bypass in production) can verify a draw's winner selection
    /// against the real randomness actually drawn.
    event DrawDartDrawn(euint64 dart);

    /// @notice Emitted when a draw completes, whether or not a prize was awarded.
    /// @dev `clearTotal` and `prize` are plaintext by design: `clearTotal` was just
    /// revealed by this same draw, and `prize` is intentionally public. Neither the
    /// winner's identity nor any depositor's balance appears here.
    event DrawCompleted(uint256 clearTotal, uint256 prize);

    /// @dev A confidential-transfer-and-call hook was invoked by a contract other than
    /// `asset`.
    error UnauthorizedToken(address caller);

    /// @dev {startDraw} was called before `drawInterval` had elapsed since {lastDraw},
    /// or while a reveal was already outstanding.
    error DrawNotReady();

    /// @dev {fulfillDraw} was called while no reveal was outstanding.
    error NoDrawInProgress();

    /// @param asset_ The ctUSD confidential token this pool accepts deposits in and
    /// pays withdrawals and prizes out in.
    /// @param yieldSource_ The yield source that funds the prize harvested at each
    /// draw.
    /// @param drawInterval_ The minimum time between the start of one draw and the
    /// next.
    constructor(IERC7984 asset_, IYieldSource yieldSource_, uint256 drawInterval_) {
        asset = asset_;
        yieldSource = yieldSource_;
        drawInterval = drawInterval_;
    }

    /// @notice Confidential-transfer-and-call hook invoked by `asset` to atomically
    /// notify this pool of an incoming deposit.
    /// @dev Credits `from`'s encrypted balance with the confidential `amount` that
    /// `asset` has already moved into this contract, adds `from` to the depositor
    /// set on first deposit, and adds the same amount actually credited to
    /// `_totalDeposits`. Returns {FHESafeMath-tryIncrease}'s own `success` flag
    /// rather than a hardcoded `true`, so that if a credit were ever to fail, `asset`
    /// would refund the depositor instead of silently swallowing the deposit.
    ///
    /// In practice this failure branch is unreachable, not merely untested: the ctUSD
    /// wrapper caps its confidential total supply at `type(uint64).max` (see
    /// {ERC7984ERC20Wrapper-maxTotalSupply}), so no single depositor's balance plus an
    /// incoming deposit can ever overflow a `euint64` add. This is defense in depth
    /// against that invariant changing upstream, not a path we can or should force
    /// open with a test backdoor. `_totalDeposits` is still advanced only by the
    /// amount actually credited (zero on that unreachable failure branch), so the
    /// solvency invariant holds even if it were ever reached.
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

        euint64 creditedAmount = FHE.select(success, amount, FHE.asEuint64(0));
        _totalDeposits = FHE.add(_totalDeposits, creditedAmount);
        FHE.allowThis(_totalDeposits);

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

        _totalDeposits = FHE.sub(_totalDeposits, amountToSend);
        FHE.allowThis(_totalDeposits);

        emit Withdrawn(msg.sender, remaining);

        FHE.allowThis(amountToSend);
        FHE.allow(amountToSend, address(asset));
        asset.confidentialTransfer(msg.sender, amountToSend);
    }

    /// @notice Starts a draw reveal: marks the encrypted aggregate total publicly
    /// decryptable and snapshots its handle for {fulfillDraw} to verify against.
    /// @dev Permissionless: anyone may trigger a draw once `drawInterval` has
    /// elapsed since {lastDraw}. Reveals only the aggregate total; nothing about any
    /// individual depositor's balance is touched.
    function startDraw() external {
        if (drawState != DrawState.Idle || block.timestamp < lastDraw + drawInterval) {
            revert DrawNotReady();
        }

        euint64 total = FHE.makePubliclyDecryptable(_totalDeposits);
        _revealingTotal = total;
        drawState = DrawState.Revealing;

        emit DrawStarted(total);
    }

    /// @notice Completes a draw reveal with the publicly-decrypted aggregate total,
    /// harvests the prize, and credits exactly one depositor: the winner.
    /// @dev Verifies `clearTotal` against the handle snapshotted by {startDraw} via
    /// {FHE.checkSignatures}, mirroring the same verification pattern used by
    /// {ERC7984ERC20Wrapper-finalizeUnwrap}. Draw state is finalized (`drawState`
    /// reset to `Idle`, `lastDraw` updated) immediately after that verification and
    /// before the harvest or the winner walk, for both the zero-total and
    /// nontrivial-total paths alike, so a reentrant call lands with `drawState`
    /// already `Idle` and is rejected by {NoDrawInProgress} in addition to the
    /// `nonReentrant` guard. If `clearTotal` is zero (an empty pool), the draw
    /// completes with no harvest and no credit. Otherwise a prize is harvested from
    /// `yieldSource` and a single winner is selected by drawing a uniformly random
    /// dart in `[0, clearTotal)` and walking every depositor's encrypted balance as a
    /// segment of `[0, clearTotal)`, crediting the prize to whichever depositor's
    /// segment contains the dart and zero to everyone else. Every depositor's balance
    /// handle changes, win or lose, so which handle changed cannot itself reveal the
    /// winner.
    ///
    /// The dart is drawn from a 128-bit random value reduced modulo `clearTotal` and
    /// then cast down to `euint64`, rather than reducing a 64-bit random directly:
    /// the modulo-reduction bias this leaves is bounded by `clearTotal / 2^128`,
    /// negligible for any total representable in a `euint64`.
    ///
    /// This walk is O(depositor count) and processes the entire depositor set in a
    /// single transaction; chunking large depositor sets across multiple
    /// transactions is deferred to a later phase.
    /// @param clearTotal The plaintext aggregate total, as publicly decrypted off
    /// chain from the handle {startDraw} snapshotted.
    /// @param proof The KMS decryption proof attesting to `clearTotal`.
    function fulfillDraw(uint256 clearTotal, bytes calldata proof) external nonReentrant {
        if (drawState != DrawState.Revealing) revert NoDrawInProgress();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint64.unwrap(_revealingTotal);
        FHE.checkSignatures(handles, abi.encode(clearTotal), proof);

        drawState = DrawState.Idle;
        lastDraw = block.timestamp;

        if (clearTotal == 0) {
            emit DrawCompleted(0, 0);
            return;
        }

        uint256 prize = yieldSource.harvest(address(this), clearTotal);

        euint128 rawDart = FHE.rem(FHE.randEuint128(), uint128(clearTotal));
        euint64 dart = FHE.asEuint64(rawDart);
        emit DrawDartDrawn(dart);

        euint64 encryptedPrize = FHE.asEuint64(uint64(prize));
        euint64 runningSum = FHE.asEuint64(0);

        uint256 depositorTotal = _depositors.length;
        for (uint256 i = 0; i < depositorTotal; i++) {
            address depositor = _depositors[i];
            euint64 balance = _balances[depositor];

            euint64 segmentStart = runningSum;
            runningSum = FHE.add(runningSum, balance);

            ebool isWinner = FHE.and(FHE.ge(dart, segmentStart), FHE.lt(dart, runningSum));
            euint64 credit = FHE.select(isWinner, encryptedPrize, FHE.asEuint64(0));

            euint64 newBalance = FHE.add(balance, credit);
            FHE.allowThis(newBalance);
            FHE.allow(newBalance, depositor);
            _balances[depositor] = newBalance;

            _totalDeposits = FHE.add(_totalDeposits, credit);
        }
        FHE.allowThis(_totalDeposits);

        emit DrawCompleted(clearTotal, prize);
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

    /// @notice Returns the encrypted aggregate of all depositor balances.
    /// @dev Not ACL-granted to any single depositor, since it belongs to none of
    /// them individually; it becomes publicly decryptable only transiently, while a
    /// draw reveal is outstanding.
    /// @return total The encrypted sum of all depositor balances.
    function totalDeposits() external view returns (euint64 total) {
        return _totalDeposits;
    }

    /// @notice Returns the number of unique addresses that have ever deposited.
    /// @return count The number of unique depositors.
    function depositorCount() external view returns (uint256 count) {
        return _depositors.length;
    }

    /// @notice Returns the depositor address at `index` in first-deposit order.
    /// @dev Intended for iteration by the draw.
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
