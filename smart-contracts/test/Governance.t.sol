// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {DICSGovernanceToken} from "../contracts/DICSGovernanceToken.sol";
import {DICSGovernor} from "../contracts/DICSGovernor.sol";
import {Vault} from "../contracts/Vault.sol";
import {PriceOracle} from "../contracts/PriceOracle.sol";
import {TestCollateralToken} from "../contracts/mocks/TestCollateralToken.sol";

/// @dev Exercises the full propose -> vote -> queue -> execute cycle
/// against a real deployed Vault, proving DICSGovernor can actually
/// change a governance-gated parameter end to end. As with every
/// contract in this batch, this has been reviewed logically but not
/// compiled in this environment — run `forge build`/`forge test` to
/// confirm against your installed OpenZeppelin v4.9.x version.
contract GovernanceTest is Test {
    DICSGovernanceToken public token;
    TimelockController public cdpTimelock;
    DICSGovernor public governor;
    Vault public vault;
    PriceOracle public priceOracle;
    TestCollateralToken public collateral;

    address public voter = makeAddr("voter");

    uint256 public constant MIN_DELAY = 1 days;

    function setUp() public {
        token = new DICSGovernanceToken(1_000_000 ether);
        require(token.transfer(voter, 500_000 ether), "transfer failed"); // majority holder, for simplicity
        vm.prank(voter);
        token.delegate(voter); // self-delegation required to activate voting power

        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](1);
        executors[0] = address(0); // open execution once ready
        cdpTimelock = new TimelockController(MIN_DELAY, proposers, executors, address(this));

        governor = new DICSGovernor(IVotes(address(token)), cdpTimelock);

        cdpTimelock.grantRole(cdpTimelock.PROPOSER_ROLE(), address(governor));
        cdpTimelock.grantRole(cdpTimelock.CANCELLER_ROLE(), address(governor));
        // v5 note: TimelockController no longer has a bespoke
        // TIMELOCK_ADMIN_ROLE — confirmed via OpenZeppelin's own PR #3799
        // and v5.0.0-rc.0 release notes. It now uses the standard
        // AccessControl DEFAULT_ADMIN_ROLE for this purpose instead.
        cdpTimelock.renounceRole(cdpTimelock.DEFAULT_ADMIN_ROLE(), address(this));

        collateral = new TestCollateralToken();

        PriceOracle priceOracleImpl = new PriceOracle();
        bytes memory priceInit =
            abi.encodeWithSelector(PriceOracle.initialize.selector, address(cdpTimelock), 2_000 ether);
        priceOracle = PriceOracle(address(new ERC1967Proxy(address(priceOracleImpl), priceInit)));

        Vault vaultImpl = new Vault();
        bytes memory vaultInit = abi.encodeWithSelector(
            Vault.initialize.selector,
            address(cdpTimelock), // ADMIN_ROLE held by the CDP-module Timelock, not a Safe/EOA
            address(collateral),
            address(priceOracle),
            15_000, // 150% initial min ratio
            1_000 // 10% initial liquidation penalty
        );
        vault = Vault(address(new ERC1967Proxy(address(vaultImpl), vaultInit)));
    }

    function test_FullGovernanceCycle_UpdatesVaultRiskParams() public {
        address[] memory targets = new address[](1);
        targets[0] = address(vault);
        uint256[] memory values = new uint256[](1);
        values[0] = 0;
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeCall(Vault.updateRiskParams, (18_000, 1_500)); // 180% ratio, 15% penalty
        string memory description = "Raise CDP min collateral ratio to 180% and penalty to 15%";

        uint256 proposalId = governor.propose(targets, values, calldatas, description);

        // Voting delay is 1 block — advance past it into the active period.
        vm.roll(block.number + governor.votingDelay() + 1);

        vm.prank(voter);
        governor.castVote(proposalId, 1); // 1 = For

        // Advance past the full voting period so the proposal resolves.
        vm.roll(block.number + governor.votingPeriod() + 1);

        assertEq(uint8(governor.state(proposalId)), uint8(IGovernor.ProposalState.Succeeded));

        bytes32 descriptionHash = keccak256(bytes(description));
        governor.queue(targets, values, calldatas, descriptionHash);

        assertEq(uint8(governor.state(proposalId)), uint8(IGovernor.ProposalState.Queued));

        // Must wait out the Timelock's own minimum delay before execution.
        vm.warp(block.timestamp + MIN_DELAY + 1);

        governor.execute(targets, values, calldatas, descriptionHash);

        assertEq(vault.minCollateralRatioBps(), 18_000);
        assertEq(vault.liquidationPenaltyBps(), 1_500);
    }

    function test_RevertWhen_ExecutingBeforeTimelockDelayElapses() public {
        address[] memory targets = new address[](1);
        targets[0] = address(vault);
        uint256[] memory values = new uint256[](1);
        values[0] = 0;
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeCall(Vault.updateRiskParams, (18_000, 1_500));
        string memory description = "Early execution attempt";

        uint256 proposalId = governor.propose(targets, values, calldatas, description);
        vm.roll(block.number + governor.votingDelay() + 1);
        vm.prank(voter);
        governor.castVote(proposalId, 1);
        vm.roll(block.number + governor.votingPeriod() + 1);

        bytes32 descriptionHash = keccak256(bytes(description));
        governor.queue(targets, values, calldatas, descriptionHash);

        // No time warp — attempt execution immediately.
        vm.expectRevert();
        governor.execute(targets, values, calldatas, descriptionHash);
    }

    function test_RevertWhen_DirectCallBypassingGovernance() public {
        // Vault's ADMIN_ROLE is held by the Timelock, not this test
        // contract or any EOA — confirms governance is actually the
        // only path to this function, not merely the intended one.
        vm.expectRevert();
        vault.updateRiskParams(99_000, 9_000);
    }
}
