// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../OracleAdapter.sol";

/// @dev Shared test/integration double implementing the minimal
///      IClaimRegistryOracleSink surface OracleAdapter calls into. Lives
///      outside test/ so both Foundry unit tests (OracleAdapter.t.sol)
///      and the integration-fixture deploy script
///      (script/DeployIntegrationFixture.s.sol) reuse the same contract
///      instead of each redeclaring it — the earlier version of
///      OracleAdapter.t.sol had this declared inline; extracted here as a
///      small cleanup while wiring up the integration test.
contract MockClaimRegistrySink is IClaimRegistryOracleSink {
    uint256 public lastClaimId;
    bytes32 public lastRequestId;
    bool public lastApproved;
    uint256 public callCount;

    function recordOracleVerification(uint256 claimId, bytes32 requestId, bool approved) external override {
        lastClaimId = claimId;
        lastRequestId = requestId;
        lastApproved = approved;
        callCount++;
    }
}
