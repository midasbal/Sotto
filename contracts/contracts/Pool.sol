// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, ebool, euint64, euint128, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {IERC7984Receiver} from "@openzeppelin/confidential-contracts/interfaces/IERC7984Receiver.sol";
import {FHESafeMath} from "@openzeppelin/confidential-contracts/utils/FHESafeMath.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
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
/// Draw lifecycle: Idle -> Revealing -> Walking -> Idle. {startDraw} moves Idle to
/// Revealing. {fulfillReveal} moves Revealing to Walking (or straight back to Idle, on
/// an empty pool). {advanceDraw} processes the depositor set in bounded batches of up
/// to {MAX_CHUNK} and moves Walking back to Idle once every depositor has been
/// processed. Deposits and withdrawals are frozen for the whole span from Revealing
/// through Walking (see {whenIdle}), not just during the walk: the walk's balances
/// must match the total that was actually revealed, and a deposit or withdrawal
/// landing mid-draw would let the aggregate total and the live balances drift apart.
///
/// {abortDraw} only ever applies in Revealing, never in Walking. Revealing is the one
/// step with a genuine external dependency: a publicly-decrypted reveal that must be
/// submitted by someone, off chain, and could in principle never arrive. Walking has
/// no such dependency; it is a fixed, deterministic amount of work over data already
/// on chain, so it always completes given enough {advanceDraw} calls. A harvested
/// prize is only ever debited from the yield source inside {fulfillReveal}, at the
/// same moment the draw commits to Walking, so an abort (Revealing-only, pre-harvest)
/// never leaves a harvested prize stranded, and Walking (post-harvest) never needs an
/// abort path to begin with: funds can never be trapped and a harvested prize can
/// never be left unallocated.
contract Pool is IERC7984Receiver, ReentrancyGuard, ZamaEthereumConfig {
    /// @notice The lifecycle state of the draw.
    enum DrawState {
        Idle,
        Revealing,
        Walking
    }

    /// @notice The maximum number of depositors {advanceDraw} processes per call.
    /// @dev Conservative on purpose. The FHEVM mock used in tests does not enforce
    /// the real per-transaction HCU budget, so this bound is chosen for safety margin
    /// rather than derived from a measured limit; confirming it fits the real Sepolia
    /// HCU budget is a phase-5 concern, not verified here.
    uint256 public constant MAX_CHUNK = 20;

    /// @notice The ctUSD confidential token this pool accepts deposits in and pays
    /// withdrawals and prizes out in.
    IERC7984 public immutable asset;

    /// @notice The yield source that funds the prize harvested at each draw.
    IYieldSource public immutable yieldSource;

    /// @notice The minimum time that must elapse between the start of one draw and
    /// the next.
    uint256 public immutable drawInterval;

    /// @notice The maximum time a draw may sit in {DrawState.Revealing} before
    /// {abortDraw} may reset it.
    uint256 public immutable drawTimeout;

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

    /// @notice The timestamp the current draw entered {DrawState.Revealing}.
    uint256 public drawStartedAt;

    /// @dev The encrypted total snapshotted and marked publicly decryptable when the
    /// current reveal was started, verified against on {fulfillReveal}. Distinct from
    /// `_totalDeposits`, which may keep moving right up until {startDraw} freezes it
    /// (deposits and withdrawals are rejected from that point on; see {whenIdle}).
    euint64 private _revealingTotal;

    /// @dev The plaintext aggregate total revealed by {fulfillReveal} for the draw
    /// currently in {DrawState.Walking}. Carried across {advanceDraw} calls purely to
    /// re-emit alongside the prize on {DrawCompleted}.
    uint256 private _revealedTotal;

    /// @dev The plaintext prize harvested by {fulfillReveal} for the draw currently
    /// in {DrawState.Walking}, re-derived into an encrypted constant on each
    /// {advanceDraw} call rather than persisted as ciphertext, since the plaintext
    /// value is already public from {DrawRevealed}. Stored as `uint64`, the same
    /// width {advanceDraw} re-derives an encrypted constant from: {fulfillReveal}
    /// validates the raw `uint256` returned by {IYieldSource-harvest} with
    /// {SafeCast-toUint64} before it is ever assigned here, so every later read of
    /// this field is already known to fit, with no separate bound to re-check.
    uint64 private _prize;

    /// @dev The encrypted winning dart for the draw currently in
    /// {DrawState.Walking}, drawn once by {fulfillReveal} and reused unchanged by
    /// every {advanceDraw} call across the walk.
    euint64 private _dart;

    /// @dev The encrypted running sum of balances processed so far in the current
    /// walk, persisted and updated across {advanceDraw} calls.
    euint64 private _runningSum;

    /// @dev The number of depositors already processed in the current walk.
    uint256 private _cursor;

    /// @dev The depositor count snapshotted when the current walk began. Depositors
    /// added after this point (blocked anyway by {whenIdle} while a draw is active)
    /// are never in scope for this draw.
    uint256 private _drawDepositorCount;

    /// @notice Emitted when `depositor`'s encrypted balance is credited by a deposit.
    /// @dev `newBalance` is an FHE ciphertext handle, never a plaintext amount.
    event Deposited(address indexed depositor, euint64 newBalance);

    /// @notice Emitted when `depositor` withdraws from the pool.
    /// @dev `newBalance` is an FHE ciphertext handle, never a plaintext amount.
    event Withdrawn(address indexed depositor, euint64 newBalance);

    /// @notice Emitted when a draw reveal is started.
    /// @dev `total` is an FHE ciphertext handle, not a plaintext amount; it is the
    /// value that must be publicly decrypted and submitted to {fulfillReveal}.
    event DrawStarted(euint64 total);

    /// @notice Emitted once the winning dart has been drawn, before any balance is
    /// credited.
    /// @dev `dart` is an FHE ciphertext handle, not a plaintext value: it is never
    /// made publicly decryptable, so revealing the handle reveals nothing on chain.
    /// It exists purely so off-chain tooling (including tests, via a debug-only
    /// decrypt with no ACL bypass in production) can verify a draw's winner selection
    /// against the real randomness actually drawn.
    event DrawDartDrawn(euint64 dart);

    /// @notice Emitted when a reveal is verified and a nonzero total moves the draw
    /// into {DrawState.Walking}.
    /// @dev `clearTotal` and `prize` are plaintext by design: `clearTotal` was just
    /// revealed by this same draw, and `prize` is intentionally public.
    event DrawRevealed(uint256 clearTotal, uint256 prize);

    /// @notice Emitted when a draw completes: either an empty-pool reveal with no
    /// walk, or a walk that has processed every depositor.
    /// @dev `clearTotal` and `prize` are plaintext by design; see {DrawRevealed}.
    /// Neither the winner's identity nor any depositor's balance appears here.
    event DrawCompleted(uint256 clearTotal, uint256 prize);

    /// @notice Emitted when a stalled reveal is aborted.
    event DrawAborted();

    /// @dev A confidential-transfer-and-call hook was invoked by a contract other than
    /// `asset`.
    error UnauthorizedToken(address caller);

    /// @dev {startDraw} was called before `drawInterval` had elapsed since {lastDraw},
    /// or while a draw was already in progress.
    error DrawNotReady();

    /// @dev {fulfillReveal} or {advanceDraw} was called while the draw was not at the
    /// step that function handles.
    error NoDrawInProgress();

    /// @dev {abortDraw} was called while the draw was not in {DrawState.Revealing},
    /// or before `drawTimeout` had elapsed since {drawStartedAt}.
    error AbortNotReady();

    /// @dev A deposit or withdrawal was attempted while a draw was in progress.
    error DrawActive();

    /// @dev Reverts with {DrawActive} unless the draw is {DrawState.Idle}. Applied to
    /// {onConfidentialTransferReceived} and {withdraw}: this is the freeze, spanning
    /// the whole draw (Revealing through Walking), not just the walk, so that by the
    /// time the walk runs, live balances still match the total that was revealed.
    modifier whenIdle() {
        if (drawState != DrawState.Idle) revert DrawActive();
        _;
    }

    /// @param asset_ The ctUSD confidential token this pool accepts deposits in and
    /// pays withdrawals and prizes out in.
    /// @param yieldSource_ The yield source that funds the prize harvested at each
    /// draw.
    /// @param drawInterval_ The minimum time between the start of one draw and the
    /// next.
    /// @param drawTimeout_ The maximum time a draw may sit in {DrawState.Revealing}
    /// before {abortDraw} may reset it.
    constructor(IERC7984 asset_, IYieldSource yieldSource_, uint256 drawInterval_, uint256 drawTimeout_) {
        asset = asset_;
        yieldSource = yieldSource_;
        drawInterval = drawInterval_;
        drawTimeout = drawTimeout_;
    }

    /// @notice Confidential-transfer-and-call hook invoked by `asset` to atomically
    /// notify this pool of an incoming deposit.
    /// @dev Credits `from`'s encrypted balance with the confidential `amount` that
    /// `asset` has already moved into this contract, adds `from` to the depositor
    /// set on first deposit, and adds the same amount actually credited to
    /// `_totalDeposits`. Returns {FHESafeMath-tryIncrease}'s own `success` flag
    /// rather than a hardcoded `true`, so that if a credit were ever to fail, `asset`
    /// would refund the depositor instead of silently swallowing the deposit.
    /// Reverts with {DrawActive} while any draw is in progress; see {whenIdle}.
    /// Guarded by `nonReentrant` for consistency with the other state-changing
    /// entry points, even though this hook makes no external calls of its own.
    ///
    /// In practice the credit-failure branch is unreachable, not merely untested: the
    /// ctUSD wrapper caps its confidential total supply at `type(uint64).max` (see
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
    ) external override nonReentrant whenIdle returns (ebool accepted) {
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
    /// external call to `asset` (checks-effects-interactions). Reverts with
    /// {DrawActive} while any draw is in progress; see {whenIdle}.
    /// @param requestedAmount The encrypted amount the caller wishes to withdraw.
    /// @param inputProof The zero-knowledge proof attesting to `requestedAmount`.
    function withdraw(externalEuint64 requestedAmount, bytes calldata inputProof) external nonReentrant whenIdle {
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
    /// decryptable and snapshots its handle for {fulfillReveal} to verify against.
    /// @dev Permissionless: anyone may trigger a draw once `drawInterval` has
    /// elapsed since {lastDraw}. Reveals only the aggregate total; nothing about any
    /// individual depositor's balance is touched. From this call onward, deposits and
    /// withdrawals revert with {DrawActive} until the draw returns to Idle.
    function startDraw() external {
        if (drawState != DrawState.Idle || block.timestamp < lastDraw + drawInterval) {
            revert DrawNotReady();
        }

        euint64 total = FHE.makePubliclyDecryptable(_totalDeposits);
        _revealingTotal = total;
        drawStartedAt = block.timestamp;
        drawState = DrawState.Revealing;

        emit DrawStarted(total);
    }

    /// @notice Verifies the publicly-decrypted aggregate total and, for a nonempty
    /// pool, harvests the prize and draws the winning dart, moving the draw into
    /// {DrawState.Walking} for {advanceDraw} to process.
    /// @dev Verifies `clearTotal` against the handle snapshotted by {startDraw} via
    /// {FHE.checkSignatures}, mirroring the same verification pattern used by
    /// {ERC7984ERC20Wrapper-finalizeUnwrap}. If `clearTotal` is zero (an empty pool),
    /// the draw completes immediately with no harvest and no walk. Otherwise the
    /// draw state is moved to Walking, and the depositor count and cursor are
    /// snapshotted, before the external {IYieldSource-harvest} call, so a reentrant
    /// call lands with `drawState` already `Walking` and is rejected by
    /// {NoDrawInProgress} in addition to the `nonReentrant` guard; a harvested prize
    /// is therefore always committed to a Walking draw that will run to completion,
    /// never left stranded by a reveal that gets abandoned.
    ///
    /// The dart is drawn from a 128-bit random value reduced modulo `clearTotal` and
    /// then cast down to `euint64`, rather than reducing a 64-bit random directly:
    /// the modulo-reduction bias this leaves is bounded by `clearTotal / 2^128`,
    /// negligible for any total representable in a `euint64`.
    ///
    /// The prize returned by `yieldSource.harvest` is validated with
    /// {SafeCast-toUint64} before being stored: `IYieldSource` is a pluggable
    /// interface, and a future or misconfigured implementation could in principle
    /// return a value above `type(uint64).max`. A raw cast would truncate that
    /// silently, crediting the winner less (or nothing) while the plaintext
    /// `DrawRevealed`/`DrawCompleted` events still advertised the untruncated
    /// amount. {SafeCast-toUint64} reverts instead, which rolls back this entire
    /// call, including the `Walking` transition above, back to `Revealing`; the
    /// draw is recoverable via {abortDraw} once `drawTimeout` elapses.
    /// @param clearTotal The plaintext aggregate total, as publicly decrypted off
    /// chain from the handle {startDraw} snapshotted.
    /// @param proof The KMS decryption proof attesting to `clearTotal`.
    function fulfillReveal(uint256 clearTotal, bytes calldata proof) external nonReentrant {
        if (drawState != DrawState.Revealing) revert NoDrawInProgress();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint64.unwrap(_revealingTotal);
        FHE.checkSignatures(handles, abi.encode(clearTotal), proof);

        if (clearTotal == 0) {
            drawState = DrawState.Idle;
            lastDraw = block.timestamp;
            emit DrawCompleted(0, 0);
            return;
        }

        drawState = DrawState.Walking;
        _revealedTotal = clearTotal;
        _cursor = 0;
        _drawDepositorCount = _depositors.length;

        uint256 prize = yieldSource.harvest(address(this), clearTotal);
        _prize = SafeCast.toUint64(prize);

        euint128 rawDart = FHE.rem(FHE.randEuint128(), uint128(clearTotal));
        euint64 dart = FHE.asEuint64(rawDart);
        FHE.allowThis(dart);
        _dart = dart;

        euint64 zero = FHE.asEuint64(0);
        FHE.allowThis(zero);
        _runningSum = zero;

        emit DrawDartDrawn(dart);
        emit DrawRevealed(clearTotal, prize);
    }

    /// @notice Processes up to `maxSteps` (capped at {MAX_CHUNK}) more depositors of
    /// the current walk, crediting the prize to whichever one's balance segment
    /// contains the dart and zero to the rest.
    /// @dev Uses the exact same segment-walk logic as a single-transaction draw would:
    /// for each depositor in turn, `segmentStart` is the running sum before them,
    /// the running sum is advanced by their balance, and they win if the dart falls
    /// in `[segmentStart, runningSum)`. Every depositor snapshotted at
    /// {fulfillReveal} is processed exactly once across however many calls this
    /// takes; there is no early exit once a winner is found, so which depositor's
    /// balance handle changed cannot itself reveal the winner. Once the cursor
    /// reaches the snapshotted depositor count, the draw returns to {DrawState.Idle}
    /// and {DrawCompleted} is emitted.
    /// @param maxSteps The maximum number of depositors to process in this call.
    function advanceDraw(uint256 maxSteps) external nonReentrant {
        if (drawState != DrawState.Walking) revert NoDrawInProgress();

        uint256 cursor = _cursor;
        uint256 remaining = _drawDepositorCount - cursor;
        uint256 step = maxSteps < MAX_CHUNK ? maxSteps : MAX_CHUNK;
        if (remaining < step) step = remaining;

        euint64 dart = _dart;
        euint64 runningSum = _runningSum;
        // `_prize` was already validated with SafeCast.toUint64 in fulfillReveal and
        // stored as uint64, so this re-derivation relies on that same bound rather
        // than re-checking or re-casting it here.
        euint64 encryptedPrize = FHE.asEuint64(_prize);

        for (uint256 i = 0; i < step; i++) {
            address depositor = _depositors[cursor + i];
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

        cursor += step;
        _cursor = cursor;
        FHE.allowThis(runningSum);
        _runningSum = runningSum;

        if (cursor == _drawDepositorCount) {
            drawState = DrawState.Idle;
            lastDraw = block.timestamp;
            emit DrawCompleted(_revealedTotal, _prize);
        }
    }

    /// @notice Resets a draw stalled in {DrawState.Revealing} back to {DrawState.Idle}.
    /// @dev Permissionless. Only ever applies in Revealing, never in Walking; see the
    /// contract-level note on why Walking needs no abort path. Does not update
    /// {lastDraw}, so a fresh {startDraw} can be retried immediately rather than
    /// waiting out another full `drawInterval`. Nothing needs to be unwound: no
    /// prize has been harvested and no depositor has been touched, since both only
    /// ever happen in {fulfillReveal}, after verification succeeds.
    function abortDraw() external {
        if (drawState != DrawState.Revealing || block.timestamp <= drawStartedAt + drawTimeout) {
            revert AbortNotReady();
        }

        drawState = DrawState.Idle;

        emit DrawAborted();
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

    /// @notice Returns how many depositors of the current walk have been processed
    /// and how many were snapshotted in total.
    /// @return cursor The number of depositors already processed in the current walk.
    /// @return total The depositor count snapshotted when the current walk began.
    function drawProgress() external view returns (uint256 cursor, uint256 total) {
        return (_cursor, _drawDepositorCount);
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
