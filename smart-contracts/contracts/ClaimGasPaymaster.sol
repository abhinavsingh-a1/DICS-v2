// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@account-abstraction/contracts/core/BasePaymaster.sol";
import "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";

/// @title ClaimGasPaymaster — EIP-4337 gas sponsorship (demo scope)
/// @notice HIGHEST-UNCERTAINTY CONTRACT IN THIS BATCH — read this whole
///         notice before deploying or relying on this contract.
///
///         Account abstraction's EntryPoint interface has moved through
///         several incompatible versions (v0.6, v0.7, and beyond — the
///         reference repository's `develop` branch was observed, at the
///         time this was written, to already be at v0.9 with further
///         changes to gas-field packing). This contract is written
///         against the v0.7 `PackedUserOperation`/`BasePaymaster`
///         interface specifically because it is the most stable,
///         widely-deployed version as of this writing — but unlike
///         every other contract in this project, the exact function
///         signatures here were NOT independently re-verified against
///         live compiler output (no network access in this environment
///         to `forge install` and actually compile). Run `forge build`
///         against whatever `@account-abstraction/contracts` version you
///         install and treat any signature mismatch as expected friction
///         to resolve, not a sign something else is wrong.
///
///         Rather than hand-implementing the low-level UserOperation gas
///         accounting and packing logic (a well-documented source of
///         subtle, security-relevant bugs — see e.g. OtterSec's public
///         writeup on paymaster gas-accounting pitfalls), this contract
///         extends eth-infinitism's own reference `BasePaymaster`, the
///         same way this project uses OpenZeppelin's audited
///         `AccessControl`/`ReentrancyGuard` instead of reimplementing
///         them. Only the sponsorship *policy* (who gets gas sponsored,
///         how much per day) is custom logic here.
///
///         SCOPE SIMPLIFICATION: this paymaster does NOT parse
///         `userOp.callData` to verify the sponsored operation is
///         actually a `ClaimRegistry.submitClaim` call — doing that
///         correctly depends on the specific smart-account
///         implementation's `execute(...)` calldata encoding, which
///         isn't fixed by this project (no smart-account contract has
///         been chosen or built). As shipped, this sponsors gas for ANY
///         operation from a sender, up to the per-day cap. Restricting
///         it to claim submissions specifically is real, necessary work
///         before this could be trusted with a shared sponsorship
///         budget — see besu-network/README.md-style "still open" notes
///         in the accompanying documentation.
contract ClaimGasPaymaster is BasePaymaster {
    /// @notice Maximum wei of gas this paymaster will sponsor for a
    ///         single sender within a rolling 24-hour bucket.
    uint256 public dailySponsorshipCapWei;

    /// @dev sender => day bucket (block.timestamp / 1 days) => wei spent
    mapping(address => mapping(uint256 => uint256)) public sponsoredToday;

    event DailyCapUpdated(uint256 newCapWei);
    event GasSponsored(address indexed sender, uint256 actualGasCost, uint256 dayBucket);

    error DailyCapExceeded(address sender, uint256 requested, uint256 alreadyUsed, uint256 cap);

    constructor(IEntryPoint entryPoint_, uint256 initialDailyCapWei) BasePaymaster(entryPoint_) {
        dailySponsorshipCapWei = initialDailyCapWei;
    }

    function setDailySponsorshipCap(uint256 newCapWei) external onlyOwner {
        dailySponsorshipCapWei = newCapWei;
        emit DailyCapUpdated(newCapWei);
    }

    /// @dev Called by EntryPoint during the validation phase, before the
    ///      UserOperation executes. `maxCost` is the worst-case gas cost
    ///      EntryPoint has pre-computed for this operation — checked
    ///      against the sender's remaining daily budget here, so
    ///      validation fails fast (before any execution happens) if the
    ///      cap would be exceeded, rather than sponsoring partially.
    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 /* userOpHash */,
        uint256 maxCost
    ) internal view override returns (bytes memory context, uint256 validationData) {
        uint256 dayBucket = block.timestamp / 1 days;
        uint256 alreadyUsed = sponsoredToday[userOp.sender][dayBucket];

        if (alreadyUsed + maxCost > dailySponsorshipCapWei) {
            revert DailyCapExceeded(userOp.sender, maxCost, alreadyUsed, dailySponsorshipCapWei);
        }

        // context carries the sender + day bucket forward to _postOp,
        // where actual (not worst-case) gas cost is recorded.
        context = abi.encode(userOp.sender, dayBucket);
        validationData = 0; // 0 = validation succeeded, no time-range restriction
    }

    /// @dev Called by EntryPoint after execution, with the ACTUAL gas
    ///      cost incurred (which is almost always less than the
    ///      worst-case `maxCost` checked above) — this is what actually
    ///      updates the sender's spent-today total, so the cap tracks
    ///      real spending, not worst-case estimates.
    function _postOp(
        PostOpMode /* mode */,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 /* actualUserOpFeePerGas */
    ) internal override {
        (address sender, uint256 dayBucket) = abi.decode(context, (address, uint256));
        sponsoredToday[sender][dayBucket] += actualGasCost;
        emit GasSponsored(sender, actualGasCost, dayBucket);
    }
}
