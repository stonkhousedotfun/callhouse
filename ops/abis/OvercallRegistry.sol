// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IOvercallRegistry} from "./interfaces/IOvercallRegistry.sol";
import {IValoremClear} from "./interfaces/IValoremClear.sol";

/// @title OvercallRegistry
/// @author Overcall
/// @notice The approved strike grid and expiry of the current Overcall cycle.
/// @dev This is the only contract Overcall deploys of its own, and it is deliberately inert. Valorem
///      Clear's `newOptionType` is permissionless, so anyone can mint an option type on NVDA with any
///      strike or any expiry; this registry is how the front end tells the five types ops created
///      from every look-alike. It records; it does not compute and it does not settle.
///
///      What it categorically is not, per V2 §10:
///        - not a router — users call the clearinghouse themselves, stay the writer, and keep their
///          own Claim NFT;
///        - not a custodian — no `payable`, no `receive`, no `fallback`, and not one `transfer`,
///          `transferFrom`, `approve` or `safeTransferFrom` in the whole file, so nothing can be sent
///          here by accident and nothing can be drained from here at all;
///        - not an oracle consumer — no price is read anywhere in this contract. The ladder is
///          derived off-chain by ops (five strikes roughly +3% to +12% over spot, about 2% apart,
///          rounded to the whole dollar) and only its outcome is recorded here.
///
///      {setCycle} is nonetheless not a rubber stamp: every id is read back from the clearinghouse
///      and matched against this registry's immutable assets, its lot size and the cycle's shared
///      timestamps, with strikes required to be strictly ascending. An id that passes is provably an
///      option type on the right collateral, the right settlement asset, the right size and the right
///      week — which is exactly the guarantee the front end needs before it renders a strike.
contract OvercallRegistry is IOvercallRegistry, Ownable2Step {
    /*//////////////////////////////////////////////////////////////
    //  Constants & Immutables
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IOvercallRegistry
    /// @dev V2 §7 fixes 24 hours as the floor for the exercise window, never a value to shave down:
    ///      Robinhood Chain has a single centralized sequencer and an outage across a short window
    ///      would stop an in-the-money holder from exercising at all. Valorem's own minimum is one
    ///      minute, which is far too permissive for this product.
    uint256 public constant MIN_EXERCISE_WINDOW = 1 days;

    /// @inheritdoc IOvercallRegistry
    /// @dev V2 §7 and §10: one asset, one expiry, four or five strikes. Depth beats breadth, and the
    ///      grid is not to be widened — five is both the target and the hard ceiling, so a sixth id
    ///      is a mistake the contract refuses rather than a choice it permits.
    uint256 public constant MAX_STRIKES = 5;

    /// @inheritdoc IOvercallRegistry
    address public immutable clearinghouse;

    /// @inheritdoc IOvercallRegistry
    address public immutable collateralToken;

    /// @inheritdoc IOvercallRegistry
    address public immutable exerciseToken;

    /*//////////////////////////////////////////////////////////////
    //  Storage
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IOvercallRegistry
    /// @dev Declared first so it packs against the inherited `Ownable2Step._pendingOwner` (160 bits)
    ///      and leaves the four fields {setCycle} writes together — `cycleNumber`, `cycleLotSize`,
    ///      `exerciseTimestamp`, `expiryTimestamp`, exactly 208 bits — sharing the following slot, so
    ///      a cycle update stays a single packed SSTORE. Grouping `lotSize` with those four would
    ///      spill them into two slots for no gain, since {setLotSize} and {setCycle} are never
    ///      called together.
    uint96 public lotSize;

    /// @inheritdoc IOvercallRegistry
    uint32 public cycleNumber;

    /// @inheritdoc IOvercallRegistry
    uint96 public cycleLotSize;

    /// @inheritdoc IOvercallRegistry
    uint40 public exerciseTimestamp;

    /// @inheritdoc IOvercallRegistry
    uint40 public expiryTimestamp;

    /// @dev The approved ids of the current cycle, ordered by ascending strike. Replaced wholesale by
    ///      {setCycle}; read through {activeOptionIds} or {cycle}.
    uint256[] private _activeOptionIds;

    /// @dev The permanent membership record: the cycle each id was approved in, 0 for never. One
    ///      SSTORE per id in {setCycle} — the same cost as the boolean index it replaces — but it
    ///      keeps answering for the ids of past cycles, which {isApproved} cannot. Valorem lets a
    ///      Claim NFT be redeemed at any point after expiry, so a writer's id must stay verifiable
    ///      long after the next cycle has taken over the front page.
    mapping(uint256 optionId => uint32 approvedInCycle) private _cycleOf;

    /// @dev Every cycle ever recorded, in order, index `cycleNumber - 1`. Appended by {setCycle} and
    ///      never mutated afterwards, so the front end can render past weeks — and a late redeemer's
    ///      own week — without replaying {CycleSet} logs, which this chain's 100 ms blocks make
    ///      expensive to scan (V2 §10, and §C.1's "no log scanning anywhere").
    Cycle[] private _history;

    /*//////////////////////////////////////////////////////////////
    //  Constructor
    //////////////////////////////////////////////////////////////*/

    /// @notice Wires the registry to one clearinghouse and one asset pair, permanently.
    /// @dev The three addresses are immutable: an Overcall deployment covers exactly one collateral
    ///      token settled in one exercise token on one clearinghouse. A different pair is a different
    ///      deployment, which keeps the trust story per-address rather than per-admin-call.
    /// @param initialOwner The admin, subject to {Ownable2Step} handover.
    /// @param clearinghouse_ The Valorem Clear instance whose option types are approved here.
    /// @param collateralToken_ The underlying token, e.g. the NVDA Stock Token (18 decimals).
    /// @param exerciseToken_ The settlement token, e.g. USDG (6 decimals).
    /// @param initialLotSize The underlying amount collateralising one contract, in 18-decimal units.
    constructor(
        address initialOwner,
        address clearinghouse_,
        address collateralToken_,
        address exerciseToken_,
        uint96 initialLotSize
    ) Ownable(initialOwner) {
        if (clearinghouse_ == address(0) || collateralToken_ == address(0) || exerciseToken_ == address(0)) {
            revert ZeroAddress();
        }
        if (collateralToken_ == exerciseToken_) revert IdenticalAssets(collateralToken_);
        if (initialLotSize == 0) revert ZeroLotSize();

        clearinghouse = clearinghouse_;
        collateralToken = collateralToken_;
        exerciseToken = exerciseToken_;
        lotSize = initialLotSize;

        emit LotSizeSet(0, initialLotSize);
    }

    /*//////////////////////////////////////////////////////////////
    //  Admin
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IOvercallRegistry
    function setCycle(uint256[] calldata optionIds, uint40 exerciseAt, uint40 expireAt) external onlyOwner {
        uint256 count = optionIds.length;
        if (count == 0) revert EmptyCycle();
        if (count > MAX_STRIKES) revert TooManyStrikes(count, MAX_STRIKES);
        if (exerciseAt <= block.timestamp) revert ExerciseNotInFuture(exerciseAt, uint40(block.timestamp));
        if (uint256(expireAt) < uint256(exerciseAt) + MIN_EXERCISE_WINDOW) {
            revert ExerciseWindowTooShort(exerciseAt, expireAt, MIN_EXERCISE_WINDOW);
        }
        // One expiry at a time (V2 §10), and never a mid-week rug of the front page. A live cycle can
        // only be replaced while NOTHING has been written on it — see {canReplaceCycle}.
        if (!canReplaceCycle()) revert CycleStillLive(expiryTimestamp);

        uint96 lot = lotSize;
        uint32 number = cycleNumber + 1;
        uint96 previousStrike;

        for (uint256 i = 0; i < count; ++i) {
            uint256 optionId = optionIds[i];
            uint96 strike = _validateOption(optionId, lot, exerciseAt, expireAt);
            // Strictly ascending strikes make the ladder sorted AND rule out duplicates in one pass:
            // the same id twice yields the same strike, which cannot be strictly greater than itself.
            if (strike <= previousStrike) revert StrikesNotAscending(optionId, previousStrike, strike);
            previousStrike = strike;
            _cycleOf[optionId] = number;
        }

        cycleNumber = number;
        cycleLotSize = lot;
        exerciseTimestamp = exerciseAt;
        expiryTimestamp = expireAt;
        _activeOptionIds = optionIds;

        // Appended field by field rather than as a struct literal: the ids arrive in calldata and a
        // literal would force a memory copy of the array before the storage write.
        Cycle storage recorded = _history.push();
        recorded.number = number;
        recorded.exerciseTimestamp = exerciseAt;
        recorded.expiryTimestamp = expireAt;
        recorded.lotSize = lot;
        recorded.optionIds = optionIds;

        emit CycleSet(number, optionIds, exerciseAt, expireAt, lot);
    }

    /// @inheritdoc IOvercallRegistry
    function setLotSize(uint96 newLotSize) external onlyOwner {
        if (newLotSize == 0) revert ZeroLotSize();
        // A live cycle was validated against the current lot size, and the option types it approved
        // have that `underlyingAmount` baked in forever. Changing it mid-cycle would leave {cycle}
        // reporting a size the approved ids do not have, so the change waits for expiry.
        if (isCycleLive()) revert CycleStillLive(expiryTimestamp);

        uint96 previousLotSize = lotSize;
        lotSize = newLotSize;

        emit LotSizeSet(previousLotSize, newLotSize);
    }

    /// @notice Permanently disabled; always reverts with {IOvercallRegistry.RenounceDisabled}.
    /// @dev {Ownable}'s renounce is a footgun with no upside here. An ownerless registry can never
    ///      record another cycle, so the front end would keep serving the last expired ladder with no
    ///      on-chain way back — a redeploy and a repoint would be the only recovery. Handing the role
    ///      over through {Ownable2Step} stays the one supported path, and `onlyOwner` is kept so a
    ///      stranger's call still fails as unauthorised rather than as disabled.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /*//////////////////////////////////////////////////////////////
    //  Views
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IOvercallRegistry
    function isApproved(uint256 optionId) external view returns (bool) {
        return _cycleOf[optionId] == cycleNumber && cycleNumber != 0;
    }

    /// @inheritdoc IOvercallRegistry
    function cycleOf(uint256 optionId) external view returns (uint32) {
        return _cycleOf[optionId];
    }

    /// @inheritdoc IOvercallRegistry
    function activeOptionIds() external view returns (uint256[] memory) {
        return _activeOptionIds;
    }

    /// @inheritdoc IOvercallRegistry
    function cycle() external view returns (Cycle memory) {
        return Cycle({
            number: cycleNumber,
            exerciseTimestamp: exerciseTimestamp,
            expiryTimestamp: expiryTimestamp,
            lotSize: cycleLotSize,
            optionIds: _activeOptionIds
        });
    }

    /// @inheritdoc IOvercallRegistry
    function isCycleLive() public view returns (bool) {
        return block.timestamp < expiryTimestamp;
    }

    /// @inheritdoc IOvercallRegistry
    /// @dev No storage of its own: the deadline IS {exerciseTimestamp}, which {setCycle} already
    ///      validated to be strictly in the future and at least {MIN_EXERCISE_WINDOW} before the
    ///      expiry, and which is 0 before the first cycle — exactly the sentinel the interface
    ///      specifies. Naming it separately is the point: `exerciseTimestamp` says what the
    ///      clearinghouse will do, `writeDeadline` says what Overcall promises, and the two happening
    ///      to be the same instant is a product decision that a future cycle shape could change
    ///      without either meaning moving.
    ///
    ///      Adds no power whatsoever. It is a pure read of a value already public, it gates nothing,
    ///      and no code path in this contract branches on it — the registry is not in the fund path
    ///      and cannot stop a write. See the interface for what the deadline protects and why the
    ///      clearinghouse's own, later, limit is not good enough for this product.
    function writeDeadline() public view returns (uint40) {
        return exerciseTimestamp;
    }

    /// @inheritdoc IOvercallRegistry
    /// @dev The `cycleNumber != 0` term is not redundant with the comparison. Before the first
    ///      {setCycle} every timestamp field is 0, so `block.timestamp < 0` is already false and the
    ///      answer would be correct by accident — but only for as long as the deadline stays a
    ///      timestamp that is zero when unset. The explicit "is there a cycle at all" test states the
    ///      precondition instead of relying on that coincidence, and it is the same test
    ///      {isApproved} makes for the same reason.
    function isWritingOpen() external view returns (bool) {
        return cycleNumber != 0 && block.timestamp < writeDeadline();
    }

    /// @inheritdoc IOvercallRegistry
    /// @dev The three ways a replacement is legitimate, in the order they are cheapest to answer:
    ///      there is no cycle yet; the recorded one has expired; or it is live but nobody has written
    ///      a single contract against it, which makes replacing it observable by no one.
    ///
    ///      "Nothing written" is read from Valorem itself rather than tracked here: `nextClaimKey`
    ///      starts at 1 on a fresh option type and increments on the FIRST write of any address, so
    ///      `nextClaimKey == 1` across the whole ladder is exactly "no short position exists". The
    ///      registry never learns of a write, and it must not — it is not in the fund path.
    function canReplaceCycle() public view returns (bool) {
        if (cycleNumber == 0) return true;
        if (block.timestamp >= expiryTimestamp) return true;

        IValoremClear clear = IValoremClear(clearinghouse);
        uint256[] memory ids = _activeOptionIds;
        for (uint256 i = 0; i < ids.length; ++i) {
            if (clear.option(ids[i]).nextClaimKey != 1) return false;
        }
        return true;
    }

    /// @inheritdoc IOvercallRegistry
    function cycleCount() external view returns (uint256) {
        return _history.length;
    }

    /// @inheritdoc IOvercallRegistry
    function cycleAt(uint256 index) external view returns (Cycle memory) {
        uint256 count = _history.length;
        if (index >= count) revert CycleIndexOutOfBounds(index, count);
        return _history[index];
    }

    /// @inheritdoc IOvercallRegistry
    /// @dev Deliberately ungated: {SetCycle} and the front end read it in a loop over ids they just
    ///      got from {activeOptionIds}, and an approval check there would only re-prove what
    ///      {setCycle} already established. Callers holding an id from elsewhere gate it themselves
    ///      with {isApproved} or {cycleOf}.
    function strikePerContract(uint256 optionId) external view returns (uint96 strike) {
        strike = IValoremClear(clearinghouse).option(optionId).exerciseAmount;
    }

    /*//////////////////////////////////////////////////////////////
    //  Internal
    //////////////////////////////////////////////////////////////*/

    /// @dev Reads `optionId` back from the clearinghouse and rejects it unless it is an option type on
    ///      this registry's exact pair, lot size and cycle window.
    ///
    ///      The {IValoremClear.TokenType} check comes first and carries most of the weight:
    ///      `option()` happily returns the PARENT option type when handed a claim NFT id, so a claim
    ///      id would otherwise sail through every field comparison below. `tokenType` reports
    ///      `Option` only when the low 96 bits are zero and the type exists, which also rejects ids
    ///      that were never created.
    /// @param optionId The candidate id.
    /// @param lot The lot size to match `underlyingAmount` against.
    /// @param exerciseAt The cycle's exercise timestamp.
    /// @param expireAt The cycle's expiry timestamp.
    /// @return strike The option's `exerciseAmount`, for the ascending-order check.
    function _validateOption(uint256 optionId, uint96 lot, uint40 exerciseAt, uint40 expireAt)
        private
        view
        returns (uint96 strike)
    {
        IValoremClear clear = IValoremClear(clearinghouse);
        if (clear.tokenType(optionId) != IValoremClear.TokenType.Option) revert NotAnOptionType(optionId);

        IValoremClear.Option memory optionInfo = clear.option(optionId);

        if (optionInfo.underlyingAsset != collateralToken) {
            revert UnderlyingAssetMismatch(optionId, collateralToken, optionInfo.underlyingAsset);
        }
        if (optionInfo.exerciseAsset != exerciseToken) {
            revert ExerciseAssetMismatch(optionId, exerciseToken, optionInfo.exerciseAsset);
        }
        if (optionInfo.underlyingAmount != lot) {
            revert LotSizeMismatch(optionId, lot, optionInfo.underlyingAmount);
        }
        if (optionInfo.exerciseTimestamp != exerciseAt) {
            revert ExerciseTimestampMismatch(optionId, exerciseAt, optionInfo.exerciseTimestamp);
        }
        if (optionInfo.expiryTimestamp != expireAt) {
            revert ExpiryTimestampMismatch(optionId, expireAt, optionInfo.expiryTimestamp);
        }

        strike = optionInfo.exerciseAmount;
        if (strike == 0) revert ZeroStrike(optionId);
    }
}
