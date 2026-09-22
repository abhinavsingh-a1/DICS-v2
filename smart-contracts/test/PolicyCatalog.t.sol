// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {InsurancePolicy} from "../contracts/InsurancePolicy.sol";
import {ClaimRegistry} from "../contracts/ClaimRegistry.sol";
import {TestPayoutToken} from "../contracts/mocks/TestPayoutToken.sol";

contract PolicyCatalogTest is Test {
    InsurancePolicy public policy;
    ClaimRegistry public registry;
    TestPayoutToken public premiumToken;
    TestPayoutToken public payoutToken;

    address public timelock = makeAddr("timelock");
    address public policyManager = makeAddr("policyManager");
    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");

    uint256 public constant TRAVEL_TEMPLATE = 1;
    uint256 public constant COVERAGE = 5_000 ether;
    uint256 public constant PREMIUM = 50 ether;
    uint256 public constant PERIOD = 30 days;
    uint256 public constant TERM = 365 days;

    function setUp() public {
        InsurancePolicy policyImpl = new InsurancePolicy();
        bytes memory policyInit = abi.encodeWithSelector(InsurancePolicy.initialize.selector, timelock);
        policy = InsurancePolicy(address(new ERC1967Proxy(address(policyImpl), policyInit)));

        payoutToken = new TestPayoutToken();
        ClaimRegistry registryImpl = new ClaimRegistry();
        bytes memory registryInit = abi.encodeWithSelector(
            ClaimRegistry.initialize.selector,
            timelock,
            address(payoutToken),
            address(policy),
            1_000_000 ether,
            10_000_000 ether,
            1 days
        );
        registry = ClaimRegistry(address(new ERC1967Proxy(address(registryImpl), registryInit)));
        require(payoutToken.transfer(address(registry), 100_000 ether), "transfer failed");

        bytes32 policyManagerRole = policy.POLICY_MANAGER_ROLE();
        vm.prank(timelock);
        policy.grantRole(policyManagerRole, policyManager);

        premiumToken = new TestPayoutToken();
        vm.prank(timelock);
        policy.setPremiumConfig(address(premiumToken), treasury, 7 days);

        vm.prank(policyManager);
        policy.addPolicyTemplate(TRAVEL_TEMPLATE, COVERAGE, PREMIUM, PERIOD, TERM, keccak256("travel-standard"));

        require(premiumToken.transfer(alice, 10_000 ether), "transfer failed");
        vm.prank(alice);
        premiumToken.approve(address(policy), type(uint256).max);
    }

    function test_SubscribeToPolicy_IssuesAndPaysAtomically() public {
        vm.prank(alice);
        uint256 policyId = policy.subscribeToPolicy(TRAVEL_TEMPLATE);

        InsurancePolicy.Policy memory p = policy.getPolicy(policyId);
        assertEq(p.holder, alice);
        assertEq(p.coverageAmount, COVERAGE);
        assertTrue(policy.isPolicyActive(policyId, block.timestamp));
        assertTrue(policy.isPremiumCurrent(policyId));
        assertEq(premiumToken.balanceOf(treasury), PREMIUM);
    }

    function test_RevertWhen_SubscribingToInactiveTemplate() public {
        vm.prank(policyManager);
        policy.setPolicyTemplateActive(TRAVEL_TEMPLATE, false);

        vm.prank(alice);
        vm.expectRevert(InsurancePolicy.PolicyTemplateInactive.selector);
        policy.subscribeToPolicy(TRAVEL_TEMPLATE);
    }

    function test_DiscontinuingTemplate_DoesNotAffectExistingPolicy() public {
        vm.prank(alice);
        uint256 policyId = policy.subscribeToPolicy(TRAVEL_TEMPLATE);

        vm.prank(policyManager);
        policy.setPolicyTemplateActive(TRAVEL_TEMPLATE, false);

        assertTrue(policy.isPolicyActive(policyId, block.timestamp));
        assertTrue(policy.isPremiumCurrent(policyId));
    }

    function test_RevertWhen_InsufficientAllowanceLeavesNoOrphanedPolicy() public {
        vm.prank(alice);
        premiumToken.approve(address(policy), 0); // revoke the setUp approval

        uint256 nextIdBefore = policy.nextPolicyId();

        vm.prank(alice);
        vm.expectRevert();
        policy.subscribeToPolicy(TRAVEL_TEMPLATE);

        // The whole transaction reverted — nextPolicyId must NOT have
        // advanced, and no Policy record should exist at that id. This
        // is the actual proof of "never a half-issued, unpaid policy."
        assertEq(policy.nextPolicyId(), nextIdBefore);
        vm.expectRevert(InsurancePolicy.PolicyNotFound.selector);
        policy.getPolicy(nextIdBefore);
    }

    function test_SubscribedPolicy_CanBeClaimedAgainstImmediately() public {
        vm.prank(alice);
        uint256 policyId = policy.subscribeToPolicy(TRAVEL_TEMPLATE);

        vm.prank(alice);
        uint256 claimId = registry.submitClaim(policyId, keccak256("delayed-flight"), 1_000 ether);
        assertEq(claimId, 1);
    }

    function test_RevertWhen_ClaimingAfterSubscribedPolicyLapses() public {
        vm.prank(alice);
        uint256 policyId = policy.subscribeToPolicy(TRAVEL_TEMPLATE);

        vm.warp(block.timestamp + PERIOD + 7 days + 1); // past period + grace, never renewed

        vm.prank(alice);
        vm.expectRevert(ClaimRegistry.PremiumNotCurrent.selector);
        registry.submitClaim(policyId, keccak256("late-claim"), 1_000 ether);
    }

    function test_SubscribeToPolicy_AutoIncrementsIdsAcrossMultipleUsers() public {
        address bob = makeAddr("bob");
        require(premiumToken.transfer(bob, 10_000 ether), "transfer failed");
        vm.prank(bob);
        premiumToken.approve(address(policy), type(uint256).max);

        vm.prank(alice);
        uint256 id1 = policy.subscribeToPolicy(TRAVEL_TEMPLATE);
        vm.prank(bob);
        uint256 id2 = policy.subscribeToPolicy(TRAVEL_TEMPLATE);

        assertTrue(id2 > id1);
        assertEq(policy.getPolicy(id1).holder, alice);
        assertEq(policy.getPolicy(id2).holder, bob);
    }
}
