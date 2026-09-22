// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {InsurancePolicy} from "../contracts/InsurancePolicy.sol";
import {ClaimRegistry} from "../contracts/ClaimRegistry.sol";
import {TestPayoutToken} from "../contracts/mocks/TestPayoutToken.sol";

/// @dev Exercises the real InsurancePolicy + real ClaimRegistry pair
/// together — unlike ClaimRegistryUpgrade.t.sol's policy-wiring tests,
/// which use a mock policy registry to isolate ClaimRegistry's own
/// logic, this file proves the premium enforcement actually works
/// end-to-end between the two real contracts. Uses TestPayoutToken as a
/// stand-in premium currency rather than the real CDP StableCoin — kept
/// deliberately decoupled, the same scoping choice made for
/// DeployIndexerFixture.s.sol; a real deployment should point
/// InsurancePolicy.setPremiumConfig at the actual StableCoin address.
contract PremiumTest is Test {
    InsurancePolicy public policy;
    ClaimRegistry public registry;
    TestPayoutToken public premiumToken;
    TestPayoutToken public payoutToken;

    address public timelock = makeAddr("timelock");
    address public policyManager = makeAddr("policyManager");
    address public underwriter = makeAddr("underwriter");
    address public treasury = makeAddr("treasury");
    address public holder = makeAddr("holder");

    uint256 public constant PREMIUM_AMOUNT = 100 ether;
    uint256 public constant PERIOD = 30 days;
    uint256 public constant GRACE = 7 days;

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

        vm.startPrank(timelock);
        policy.grantRole(policy.POLICY_MANAGER_ROLE(), policyManager);
        registry.grantRole(registry.UNDERWRITER_ROLE(), underwriter);
        vm.stopPrank();

        premiumToken = new TestPayoutToken();
        vm.prank(timelock);
        policy.setPremiumConfig(address(premiumToken), treasury, GRACE);

        vm.prank(policyManager);
        policy.registerPolicy(1, holder, 0, type(uint40).max, 1_000_000 ether, keccak256("policy-1"));
        vm.prank(policyManager);
        policy.setPremiumTerms(1, PREMIUM_AMOUNT, PERIOD);

        require(premiumToken.transfer(holder, 10_000 ether), "transfer failed");
        vm.prank(holder);
        premiumToken.approve(address(policy), type(uint256).max);
    }

    function test_PayPremium_ExtendsFromNowWhenNoPriorPayment() public {
        vm.prank(holder);
        policy.payPremium(1);

        assertEq(policy.premiumPaidUntil(1), block.timestamp + PERIOD);
        assertEq(premiumToken.balanceOf(treasury), PREMIUM_AMOUNT);
    }

    function test_PayPremium_StacksOnRemainingPeriodRatherThanWastingIt() public {
        vm.prank(holder);
        policy.payPremium(1);
        uint256 firstPaidUntil = policy.premiumPaidUntil(1);

        // Pay again well before the first period expires.
        vm.warp(block.timestamp + 10 days);
        vm.prank(holder);
        policy.payPremium(1);

        // Second payment extends from the FIRST payment's expiry, not
        // from "now" — proving the remaining 20 days weren't discarded.
        assertEq(policy.premiumPaidUntil(1), firstPaidUntil + PERIOD);
    }

    function test_IsPremiumCurrent_TrueWithinGracePeriodAfterLapse() public {
        vm.prank(holder);
        policy.payPremium(1);

        vm.warp(block.timestamp + PERIOD + GRACE - 1);
        assertTrue(policy.isPremiumCurrent(1));

        vm.warp(block.timestamp + 2);
        assertFalse(policy.isPremiumCurrent(1));
    }

    function test_UnconfiguredPremiumTermsAreExempt() public {
        vm.prank(policyManager);
        policy.registerPolicy(2, holder, 0, type(uint40).max, 1_000 ether, keccak256("policy-2"));
        // setPremiumTerms never called for policy 2
        assertTrue(policy.isPremiumCurrent(2));
    }

    function test_RevertWhen_NonHolderPaysPremium() public {
        address impostor = makeAddr("impostor");
        require(premiumToken.transfer(impostor, 1_000 ether), "transfer failed");
        vm.prank(impostor);
        premiumToken.approve(address(policy), type(uint256).max);

        vm.prank(impostor);
        vm.expectRevert(InsurancePolicy.OnlyPolicyHolderCanPay.selector);
        policy.payPremium(1);
    }

    // ── End-to-end: premium status actually blocks/allows claims ──────

    function test_ClaimSubmission_SucceedsWhenPremiumCurrent() public {
        vm.prank(holder);
        policy.payPremium(1);

        vm.prank(holder);
        uint256 claimId = registry.submitClaim(1, keccak256("evidence"), 500 ether);
        assertEq(claimId, 1);
    }

    function test_RevertWhen_ClaimSubmittedAfterPremiumLapsed() public {
        vm.prank(holder);
        policy.payPremium(1);

        vm.warp(block.timestamp + PERIOD + GRACE + 1);

        vm.prank(holder);
        vm.expectRevert(ClaimRegistry.PremiumNotCurrent.selector);
        registry.submitClaim(1, keccak256("evidence"), 500 ether);
    }

    function test_ClaimSubmission_AllowedWhenNeverBilled() public {
        vm.prank(policyManager);
        policy.registerPolicy(3, holder, 0, type(uint40).max, 1_000 ether, keccak256("policy-3"));
        // No setPremiumTerms call — premium-exempt by design.

        vm.prank(holder);
        uint256 claimId = registry.submitClaim(3, keccak256("evidence"), 100 ether);
        assertEq(claimId, 1);
    }
}
