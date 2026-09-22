// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/governance/Governor.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import "@openzeppelin/contracts/governance/utils/IVotes.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title DICSGovernor — token-voting governance for the CDP module only
/// @notice Governs Vault.sol's risk parameters and PriceOracle's admin
///         role, via its own dedicated TimelockController (deployed
///         separately, NOT the same Timelock that governs
///         ClaimRegistry/InsurancePolicy/OracleAdapter — see
///         DICSGovernanceToken.sol's header for why these stay separate
///         governance domains). This contract itself becomes the
///         PROPOSER on that dedicated Timelock; execution still passes
///         through the Timelock's normal queue-then-execute delay, so a
///         passed vote is not instantly executed — it's visible and
///         delayed exactly like every other privileged action in this
///         project.
/// @dev OVERRIDE SET — CONFIRMED against a real forge build, round 3.
///      This diamond genuinely shifted between build attempts: an
///      earlier round found `votingDelay`/`votingPeriod`/`quorum` needed
///      `IGovernor` named (not `Governor`), and that was correct for
///      whatever exact commit was installed at the time. This round's
///      build reported the OPPOSITE for the same three functions
///      (`Governor` required, `IGovernor` invalid) — and, tellingly,
///      this round's error output shows `Governor` itself now directly
///      inheriting `Nonces`, which the earlier round's output did not
///      show. That's evidence the installed OpenZeppelin commit changed
///      between attempts, not that either round's fix was applied
///      wrong. Practical takeaway: pin the exact commit hash (not just
///      the `v5.7.0` tag) once this build goes green, or this exact
///      class of flip-flop can recur. The override list below is
///      correct for whatever commit produced the error this fix
///      responds to — not guaranteed permanent.
///      `IGovernor` is no longer imported or referenced anywhere in
///      this file, since none of the current overrides need it.
///      `supportsInterface` also changed: `GovernorTimelockControl` is
///      no longer a valid second name for it in this commit — `Governor`
///      alone is what's required.
///      `proposalNeedsQueuing` is a function this file didn't have at
///      all before this round — v5 requires it explicitly overridden
///      wherever both `Governor` and `GovernorTimelockControl` are
///      inherited together, confirmed by this round's
///      "Derived contract must override function proposalNeedsQueuing"
///      error.
contract DICSGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    constructor(IVotes token_, TimelockController timelock_)
        Governor("DICSGovernor")
        GovernorSettings(
            1,      // voting delay: 1 block after proposal creation
            50_400, // voting period: ~1 week, assuming ~12s blocks
            0       // proposal threshold: any token holder may propose
        )
        GovernorVotes(token_)
        GovernorVotesQuorumFraction(4) // 4% of total supply must vote for quorum
        GovernorTimelockControl(timelock_)
    {}

    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingDelay();
    }

    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingPeriod();
    }

    function quorum(uint256 blockNumber)
        public
        view
        override(Governor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        return super.quorum(blockNumber);
    }

    function state(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (ProposalState)
    {
        return super.state(proposalId);
    }

    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.proposalThreshold();
    }

    /// @dev NEW in this round — v5 added this function to Governor's
    ///      core module (with a body) and GovernorTimelockControl
    ///      overrides it too, creating the same two-parent diamond every
    ///      other function in this file already resolves the same way.
    function proposalNeedsQueuing(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    {
        return super.proposalNeedsQueuing(proposalId);
    }

    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor() internal view override(Governor, GovernorTimelockControl) returns (address) {
        return super._executor();
    }

    /// @dev CHANGED this round: `GovernorTimelockControl` is no longer a
    ///      valid second name here — confirmed by this round's "Invalid
    ///      contract specified in override list: GovernorTimelockControl"
    ///      error. `Governor` alone resolves it in this commit.
    function supportsInterface(bytes4 interfaceId) public view override(Governor) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
