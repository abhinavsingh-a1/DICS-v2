// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ClaimRegistry, IInsurancePolicyRegistry} from "../contracts/ClaimRegistry.sol";

/// @dev Minimal ERC20 stand-in for the payout token in these tests.
contract TestToken is ERC20 {
    constructor() ERC20("Test", "TST") {
        _mint(msg.sender, 1_000_000 ether);
    }
}

/// @dev Illustrative V2: adds one new field to prove storage survives an
///      upgrade. In a real V2 this would live in its own file
///      (ClaimRegistryV2.sol) — kept inline here for test locality.
contract ClaimRegistryV2 is ClaimRegistry {
    uint256 public newFieldAddedInV2;

    function setNewField(uint256 value) external {
        newFieldAddedInV2 = value;
    }

    function version() external pure returns (string memory) {
        return "v2";
    }
}

/// @dev Test double for InsurancePolicy — implements just enough of
///      IInsurancePolicyRegistry to let ClaimRegistry tests control policy
///      state directly, without standing up a full InsurancePolicy proxy.
contract MockPolicyRegistry is IInsurancePolicyRegistry {
    mapping(uint256 => Policy) private _policies;
    bool public premiumCurrent = true; // permissive default — these tests aren't about premium logic

    function setPolicy(uint256 policyId, Policy calldata p) external {
        _policies[policyId] = p;
    }

    function getPolicy(uint256 policyId) external view override returns (Policy memory) {
        return _policies[policyId];
    }

    function isPremiumCurrent(uint256) external view override returns (bool) {
        return premiumCurrent;
    }

    function setPremiumCurrent(bool value) external {
        premiumCurrent = value;
    }
}

contract ClaimRegistryUpgradeTest is Test {
    ClaimRegistry public registry; // typed as V1 interface, points at proxy
    ERC1967Proxy public proxy;
    TestToken public token;
    MockPolicyRegistry public policyRegistryMock;

    address public timelock = makeAddr("timelock");
    address public underwriter = makeAddr("underwriter");
    address public claimant = makeAddr("claimant");
    address public policyRegistry = makeAddr("policyRegistry");

    function setUp() public {
        vm.label(timelock, "Timelock");
        vm.label(underwriter, "Underwriter");
        vm.label(claimant, "Claimant");

        token = new TestToken();
        policyRegistryMock = new MockPolicyRegistry();

        // A generously-covered, currently-active policy held by `claimant`.
        // Coverage is set high so tests exercising rate limits / upgrades /
        // pausing aren't incidentally also testing the coverage check —
        // each test should isolate the one thing it's verifying.
        policyRegistryMock.setPolicy(
            1,
            IInsurancePolicyRegistry.Policy({
                policyId: 1,
                coverageAmount: 1_000_000 ether,
                holder: claimant,
                validFrom: 0,
                validUntil: type(uint40).max,
                revoked: false,
                metadataHash: keccak256("policy-1")
            })
        );

        ClaimRegistry implementation = new ClaimRegistry();

        bytes memory initData = abi.encodeWithSelector(
            ClaimRegistry.initialize.selector,
            timelock,
            address(token),
            address(policyRegistryMock),
            1_000 ether,   // maxPayoutPerClaim
            10_000 ether,  // maxPayoutPerWindow
            1 days         // rateLimitWindowSeconds
        );

        proxy = new ERC1967Proxy(address(implementation), initData);
        registry = ClaimRegistry(address(proxy));

        bytes32 underwriterRole = registry.UNDERWRITER_ROLE();
        vm.prank(timelock);
        registry.grantRole(underwriterRole, underwriter);

        require(token.transfer(address(registry), 50_000 ether), "transfer failed");
    }

    function test_StateSurvivesUpgrade() public {
        // Write state under V1
        vm.prank(claimant);
        uint256 claimId = registry.submitClaim(1, keccak256("evidence"), 500 ether);

        vm.prank(underwriter);
        registry.setClaimStatus(claimId, ClaimRegistry.ClaimStatus.Approved);

        vm.prank(underwriter);
        registry.payoutClaim(claimId);

        (, , address storedClaimant, uint96 amount, ClaimRegistry.ClaimStatus status, , , ) =
            registry.claims(claimId);
        assertEq(storedClaimant, claimant);
        assertEq(amount, 500 ether);
        assertEq(uint8(status), uint8(ClaimRegistry.ClaimStatus.Paid));

        // Upgrade to V2
        ClaimRegistryV2 implementationV2 = new ClaimRegistryV2();
        vm.prank(timelock);
        registry.upgradeToAndCall(address(implementationV2), "");

        ClaimRegistryV2 upgraded = ClaimRegistryV2(address(proxy));

        // Original state must be unchanged after upgrade
        (, , address claimantAfter, uint96 amountAfter, ClaimRegistry.ClaimStatus statusAfter, , , ) =
            upgraded.claims(claimId);
        assertEq(claimantAfter, claimant, "claimant lost after upgrade");
        assertEq(amountAfter, 500 ether, "amount corrupted after upgrade");
        assertEq(uint8(statusAfter), uint8(ClaimRegistry.ClaimStatus.Paid), "status corrupted after upgrade");

        // New V2 behavior works
        assertEq(upgraded.version(), "v2");
        upgraded.setNewField(42);
        assertEq(upgraded.newFieldAddedInV2(), 42);
    }

    function test_RevertWhen_NonUpgraderCallsUpgrade() public {
        ClaimRegistryV2 implementationV2 = new ClaimRegistryV2();
        vm.prank(claimant); // claimant has no UPGRADER_ROLE
        vm.expectRevert();
        registry.upgradeToAndCall(address(implementationV2), "");
    }

    function test_RevertWhen_PausedRejectsSubmitClaim() public {
        bytes32 pauserRole = registry.PAUSER_ROLE();
        vm.prank(timelock);
        registry.grantRole(pauserRole, timelock);
        vm.prank(timelock);
        registry.pause();

        vm.prank(claimant);
        vm.expectRevert();
        registry.submitClaim(1, keccak256("x"), 10 ether);
    }

    function test_RevertWhen_ClaimExceedsRateLimitWindow() public {
        // maxPayoutPerWindow = 10_000 ether; submit/approve/pay claims
        // until the window cap is exceeded.
        for (uint256 i = 0; i < 10; i++) {
            vm.prank(claimant);
            uint256 claimId = registry.submitClaim(1, keccak256(abi.encode(i)), 1_000 ether);
            vm.prank(underwriter);
            registry.setClaimStatus(claimId, ClaimRegistry.ClaimStatus.Approved);
            vm.prank(underwriter);
            registry.payoutClaim(claimId); // 10th payout hits exactly 10_000 ether
        }

        vm.prank(claimant);
        uint256 overCap = registry.submitClaim(1, keccak256("over"), 1_000 ether);
        vm.prank(underwriter);
        registry.setClaimStatus(overCap, ClaimRegistry.ClaimStatus.Approved);

        vm.prank(underwriter);
        vm.expectRevert(ClaimRegistry.RateLimitWindowExceeded.selector);
        registry.payoutClaim(overCap);
    }

    function test_RescueForeignToken_RevertsOnPayoutToken() public {
        vm.prank(timelock);
        vm.expectRevert(ClaimRegistry.CannotRescuePayoutToken.selector);
        registry.rescueForeignToken(address(token), timelock, 1 ether);
    }

    // ── Policy-wiring tests ────────────────────────────────────────

    function test_RevertWhen_ClaimantIsNotPolicyHolder() public {
        address impostor = makeAddr("impostor");
        vm.prank(impostor);
        vm.expectRevert(ClaimRegistry.NotPolicyHolder.selector);
        registry.submitClaim(1, keccak256("x"), 100 ether);
    }

    function test_RevertWhen_PolicyRevoked() public {
        policyRegistryMock.setPolicy(
            2,
            IInsurancePolicyRegistry.Policy({
                policyId: 2,
                coverageAmount: 1_000_000 ether,
                holder: claimant,
                validFrom: 0,
                validUntil: type(uint40).max,
                revoked: true,
                metadataHash: keccak256("policy-2")
            })
        );
        vm.prank(claimant);
        vm.expectRevert(ClaimRegistry.PolicyNotActive.selector);
        registry.submitClaim(2, keccak256("x"), 100 ether);
    }

    function test_RevertWhen_PolicyNotYetValid() public {
        policyRegistryMock.setPolicy(
            3,
            IInsurancePolicyRegistry.Policy({
                policyId: 3,
                coverageAmount: 1_000_000 ether,
                holder: claimant,
                validFrom: uint40(block.timestamp + 1_000),
                validUntil: type(uint40).max,
                revoked: false,
                metadataHash: keccak256("policy-3")
            })
        );
        vm.prank(claimant);
        vm.expectRevert(ClaimRegistry.PolicyNotActive.selector);
        registry.submitClaim(3, keccak256("x"), 100 ether);
    }

    function test_RevertWhen_ClaimExceedsPolicyCoverage() public {
        policyRegistryMock.setPolicy(
            4,
            IInsurancePolicyRegistry.Policy({
                policyId: 4,
                coverageAmount: 500 ether,
                holder: claimant,
                validFrom: 0,
                validUntil: type(uint40).max,
                revoked: false,
                metadataHash: keccak256("policy-4")
            })
        );
        vm.prank(claimant);
        vm.expectRevert(ClaimRegistry.ClaimExceedsPolicyCoverage.selector);
        registry.submitClaim(4, keccak256("x"), 600 ether);
    }

    function test_RevertWhen_CumulativeNonRejectedClaimsExceedCoverage() public {
        policyRegistryMock.setPolicy(
            5,
            IInsurancePolicyRegistry.Policy({
                policyId: 5,
                coverageAmount: 900 ether,
                holder: claimant,
                validFrom: 0,
                validUntil: type(uint40).max,
                revoked: false,
                metadataHash: keccak256("policy-5")
            })
        );

        vm.prank(claimant);
        registry.submitClaim(5, keccak256("first"), 500 ether); // consumed: 500

        // Second claim alone is under the 900 cap, but 500 + 500 > 900 —
        // the still-pending first claim continues to reserve coverage.
        vm.prank(claimant);
        vm.expectRevert(ClaimRegistry.ClaimExceedsPolicyCoverage.selector);
        registry.submitClaim(5, keccak256("second"), 500 ether);
    }

    function test_RejectedClaimFreesUpCoverageForNewSubmission() public {
        policyRegistryMock.setPolicy(
            6,
            IInsurancePolicyRegistry.Policy({
                policyId: 6,
                coverageAmount: 900 ether,
                holder: claimant,
                validFrom: 0,
                validUntil: type(uint40).max,
                revoked: false,
                metadataHash: keccak256("policy-6")
            })
        );

        vm.prank(claimant);
        uint256 firstClaim = registry.submitClaim(6, keccak256("first"), 500 ether);

        vm.prank(underwriter);
        registry.setClaimStatus(firstClaim, ClaimRegistry.ClaimStatus.Rejected);

        // Now that the first claim is Rejected, it no longer counts toward
        // consumed coverage, so a second 500-ether claim should succeed.
        vm.prank(claimant);
        registry.submitClaim(6, keccak256("second"), 500 ether);
    }

    function test_RevertWhen_PolicyPremiumLapsed() public {
        policyRegistryMock.setPremiumCurrent(false);

        vm.prank(claimant);
        vm.expectRevert(ClaimRegistry.PremiumNotCurrent.selector);
        registry.submitClaim(1, keccak256("x"), 100 ether);
    }

    function test_RevertWhen_PolicyRegistryNotSet() public {
        // Deploy a second, freshly-initialized registry with the zero
        // address as its policy registry to exercise this specific guard.
        ClaimRegistry implementation = new ClaimRegistry();
        bytes memory initData = abi.encodeWithSelector(
            ClaimRegistry.initialize.selector,
            timelock,
            address(token),
            address(0),
            1_000 ether,
            10_000 ether,
            1 days
        );
        ERC1967Proxy freshProxy = new ERC1967Proxy(address(implementation), initData);
        ClaimRegistry freshRegistry = ClaimRegistry(address(freshProxy));

        vm.prank(claimant);
        vm.expectRevert(ClaimRegistry.PolicyRegistryNotSet.selector);
        freshRegistry.submitClaim(1, keccak256("x"), 10 ether);
    }
}
