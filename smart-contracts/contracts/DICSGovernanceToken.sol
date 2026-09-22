// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/utils/Nonces.sol";

/// @title DICSGovernanceToken — voting weight for CDP-module governance
/// @notice SCOPE NOTE: this token governs ONLY the CDP module's risk
///         parameters (Vault.sol's minCollateralRatioBps,
///         liquidationPenaltyBps, and PriceOracle's admin/signer set) —
///         see DICSGovernor.sol. It has no authority whatsoever over
///         ClaimRegistry, InsurancePolicy, or OracleAdapter, which
///         remain governed by their own Safe + TimelockController as
///         documented in besu-network/README.md. Two separate
///         governance domains, deliberately not unified into one,
///         because "who can change CDP collateral ratios" and "who can
///         approve insurance claims" are different trust boundaries with
///         no reason to share a single point of control.
/// @dev ERC20Votes requires ERC20Permit (for gasless delegation via
///      signatures) as a dependency — both are standard OpenZeppelin
///      extensions, not custom logic. Initial supply is minted entirely
///      to the deployer at construction; distributing it to real
///      stakeholders is a deployment-time / off-chain decision outside
///      this contract's scope.
contract DICSGovernanceToken is ERC20, ERC20Permit, ERC20Votes {
    constructor(uint256 initialSupply)
        ERC20("DICS Governance Token (demo)", "DICSGOV")
        ERC20Permit("DICS Governance Token (demo)")
    {
        _mint(msg.sender, initialSupply);
    }

    // CONFIRMED against a real forge build error: neither `ERC20Permit`
    // nor `ERC20Votes` implements `nonces` itself — both merely inherit
    // it from `Nonces` (ERC20Votes via its `Votes` base). The actual
    // contract needing to be named is `Nonces` directly, not
    // `ERC20Votes` — naming `ERC20Votes` here was the mistake the error
    // caught ("Invalid contract specified in override list: ERC20Votes",
    // "Function needs to specify overridden contract Nonces").

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
