// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {InsurancePolicy} from "../contracts/InsurancePolicy.sol";

contract InsurancePolicyTest is Test {
    InsurancePolicy public policy;

    address public timelock = makeAddr("timelock");
    address public policyManager = makeAddr("policyManager");
    address public holder = makeAddr("holder");
    address public otherWallet = makeAddr("otherWallet");

    function setUp() public {
        InsurancePolicy implementation = new InsurancePolicy();
        bytes memory initData = abi.encodeWithSelector(InsurancePolicy.initialize.selector, timelock);
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
        policy = InsurancePolicy(address(proxy));

        bytes32 policyManagerRole = policy.POLICY_MANAGER_ROLE();
        vm.prank(timelock);
        policy.grantRole(policyManagerRole, policyManager);

        vm.prank(policyManager);
        policy.registerPolicy(1, holder, 1_000, 2_000, 5_000 ether, keccak256("policy-doc"));
    }

    function test_RegisterPolicy_StoresCorrectData() public view {
        InsurancePolicy.Policy memory p = policy.getPolicy(1);
        assertEq(p.holder, holder);
        assertEq(p.coverageAmount, 5_000 ether);
        assertFalse(p.revoked);
    }

    function test_RevertWhen_DuplicatePolicyId() public {
        vm.prank(policyManager);
        vm.expectRevert(InsurancePolicy.PolicyAlreadyExists.selector);
        policy.registerPolicy(1, holder, 1_000, 2_000, 1_000 ether, keccak256("dup"));
    }

    function test_RevertWhen_NonManagerRegisters() public {
        vm.prank(otherWallet);
        vm.expectRevert();
        policy.registerPolicy(2, holder, 1_000, 2_000, 1_000 ether, keccak256("x"));
    }

    function test_IsPolicyActive_TrueWithinWindow() public view {
        assertTrue(policy.isPolicyActive(1, 1_500));
    }

    function test_IsPolicyActive_FalseBeforeStart() public view {
        assertFalse(policy.isPolicyActive(1, 999));
    }

    function test_IsPolicyActive_FalseAfterExpiry() public view {
        assertFalse(policy.isPolicyActive(1, 2_001));
    }

    function test_IsPolicyActive_FalseWhenRevoked() public {
        vm.prank(policyManager);
        policy.revokePolicy(1);
        assertFalse(policy.isPolicyActive(1, 1_500));
    }

    function test_IsClaimEligible_TrueForValidClaim() public view {
        assertTrue(policy.isClaimEligible(1, holder, 3_000 ether, 1_500));
    }

    function test_IsClaimEligible_FalseForWrongClaimant() public view {
        assertFalse(policy.isClaimEligible(1, otherWallet, 1_000 ether, 1_500));
    }

    function test_IsClaimEligible_FalseWhenExceedsCoverage() public view {
        assertFalse(policy.isClaimEligible(1, holder, 6_000 ether, 1_500));
    }

    function test_RevertWhen_PausedRegistration() public {
        bytes32 pauserRole = policy.PAUSER_ROLE();
        vm.prank(timelock);
        policy.grantRole(pauserRole, timelock);
        vm.prank(timelock);
        policy.pause();

        vm.prank(policyManager);
        vm.expectRevert();
        policy.registerPolicy(2, holder, 1_000, 2_000, 1_000 ether, keccak256("y"));
    }
}
