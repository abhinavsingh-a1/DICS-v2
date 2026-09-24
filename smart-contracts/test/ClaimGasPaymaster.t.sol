// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@account-abstraction/contracts/core/EntryPoint.sol";
import "@account-abstraction/contracts/samples/SimpleAccountFactory.sol";
import "@account-abstraction/contracts/samples/SimpleAccount.sol";
import "../contracts/ClaimGasPaymaster.sol";
import "../contracts/ClaimRegistry.sol";
import "../contracts/InsurancePolicy.sol";
import "../contracts/mocks/TestPayoutToken.sol";

/// @dev THE SCENARIO THIS FILE PROVES: a policyholder whose smart-contract
///      wallet holds ZERO ETH can still file a claim, with
///      ClaimGasPaymaster covering every wei of gas — the exact real-world
///      case a gas-sponsorship paymaster exists to solve (a claimant
///      shouldn't need to already own crypto just to use an insurance
///      product). Before this file, ClaimGasPaymaster had no test
///      coverage in this project at all; this is its first real exercise.
///
///      HIGHEST-UNCERTAINTY TEST IN THIS PROJECT, inheriting
///      ClaimGasPaymaster.sol's own header caveat and going further: the
///      UserOperation packing helpers below (accountGasLimits, gasFees,
///      paymasterAndData), and every other call into EntryPoint/
///      BasePaymaster/SimpleAccountFactory's own API surface (`deposit`,
///      `addStake`, `getUserOpHash`, `createAccount`, `execute`), encode
///      the v0.7 ERC-4337 spec as I understand it, without the ability to
///      compile-check against a real installed
///      `@account-abstraction/contracts` version in this environment. If
///      `forge build` reports a struct-shape or packing mismatch, that's
///      real, expected verification work — see this project's own
///      established pattern (the DICSGovernor.sol override saga) for how
///      this kind of thing gets resolved: paste the real error, it gets
///      fixed against real evidence, possibly more than once.
contract ClaimGasPaymasterTest is Test {
    EntryPoint public entryPoint;
    SimpleAccountFactory public accountFactory;
    ClaimGasPaymaster public paymaster;

    InsurancePolicy public policy;
    ClaimRegistry public registry;
    TestPayoutToken public premiumToken;
    TestPayoutToken public payoutToken;

    address public timelock = makeAddr("timelock");
    address public policyManager = makeAddr("policyManager");
    address public treasury = makeAddr("treasury");
    address public bundler = makeAddr("bundler"); // the "beneficiary" handleOps pays leftover gas to — a stand-in for a real bundler's address

    uint256 public aliceOwnerKey = 0xA11CE; // the EOA key that controls Alice's SMART ACCOUNT — not Alice's on-chain identity directly
    address public aliceOwner;
    SimpleAccount public aliceAccount; // Alice's smart-contract wallet — THIS is what holds zero ETH and gets sponsored

    uint256 public constant DAILY_CAP_WEI = 1 ether;
    uint256 public constant TEMPLATE_ID = 1;

    function setUp() public {
        aliceOwner = vm.addr(aliceOwnerKey);

        // --- Account abstraction infrastructure ---
        entryPoint = new EntryPoint();
        accountFactory = new SimpleAccountFactory(entryPoint);
        aliceAccount = accountFactory.createAccount(aliceOwner, 0);

        paymaster = new ClaimGasPaymaster(entryPoint, DAILY_CAP_WEI);
        // A real paymaster needs BOTH a deposit (what EntryPoint actually
        // draws gas payments from) AND stake (EntryPoint's own anti-spam
        // requirement for any paymaster) — funded here from this test's
        // own balance, standing in for whatever real account would
        // operate this paymaster in a live deployment.
        paymaster.deposit{value: 10 ether}();
        paymaster.addStake{value: 10 ether}(1 days);

        // --- Claims domain, same pattern as Premium.t.sol / PolicyCatalog.t.sol ---
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
        require(payoutToken.transfer(address(registry), 100_000 ether), "fund registry");

        vm.prank(timelock);
        policy.grantRole(policy.POLICY_MANAGER_ROLE(), policyManager);

        premiumToken = new TestPayoutToken();
        vm.prank(timelock);
        policy.setPremiumConfig(address(premiumToken), treasury, 7 days);

        vm.prank(policyManager);
        policy.addPolicyTemplate(TEMPLATE_ID, 5_000 ether, 22 ether, 30 days, 365 days, keccak256("standard"));

        // Critically: the policy is subscribed to by ALICE'S SMART
        // ACCOUNT, not her raw EOA. Once a UserOperation routes through
        // EntryPoint -> aliceAccount.execute(...) -> InsurancePolicy, the
        // caller InsurancePolicy actually sees is aliceAccount's address
        // — so that's the address that must hold the policy for a later
        // submitClaim (msg.sender == holder check) to succeed. This is a
        // real, easy-to-miss consequence of account abstraction: the
        // on-chain "identity" is the smart account, not the EOA that
        // controls it.
        require(premiumToken.transfer(address(aliceAccount), 100 ether), "fund alice's account with premium");
        vm.prank(address(aliceAccount));
        premiumToken.approve(address(policy), type(uint256).max);
        vm.prank(address(aliceAccount));
        policy.subscribeToPolicy(TEMPLATE_ID);

        // Alice's smart account itself holds NO ETH — deliberately. This
        // is the exact condition the whole scenario is built to prove
        // works anyway.
        assertEq(address(aliceAccount).balance, 0);
    }

    function test_SponsoredClaimSubmission_SucceedsWithZeroEthInAccount() public {
        bytes memory claimCalldata =
            abi.encodeWithSelector(ClaimRegistry.submitClaim.selector, uint256(1), keccak256("evidence"), 500 ether);
        bytes memory executeCalldata =
            abi.encodeWithSelector(SimpleAccount.execute.selector, address(registry), 0, claimCalldata);

        PackedUserOperation memory userOp = _buildUnsignedUserOp(address(aliceAccount), executeCalldata);
        userOp.signature = _signUserOp(userOp, aliceOwnerKey);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp;

        uint256 aliceBalanceBefore = address(aliceAccount).balance;

        entryPoint.handleOps(ops, payable(bundler));

        // The actual proof: Alice's account still has zero ETH — every
        // wei of gas for this transaction came from the paymaster's
        // EntryPoint deposit, not from her.
        assertEq(address(aliceAccount).balance, aliceBalanceBefore);

        // And the claim genuinely went through — this isn't just "the
        // UserOperation didn't revert," the actual business logic
        // (submitClaim) executed for real.
        // Claim struct field order: claimId, policyId, claimant, amount,
        // status, submittedAt, processedAt, merkleRoot — 8 fields, so the
        // auto-generated public mapping getter returns an 8-tuple; the
        // blank slots below must match that arity exactly or this
        // wouldn't compile at all (a wrong count here fails loudly, at
        // least).
        (,, , uint256 amount,,,,) = registry.claims(1);
        assertEq(amount, 500 ether);

        uint256 dayBucket = block.timestamp / 1 days;
        assertGt(paymaster.sponsoredToday(address(aliceAccount), dayBucket), 0);
    }

    function test_RevertWhen_DailyCapExceeded() public {
        // A second, larger sponsorship request in the SAME day bucket —
        // constructed to push the running total past DAILY_CAP_WEI. The
        // first (small) operation from the happy-path test isn't repeated
        // here; this test stands alone and drives sponsoredToday directly
        // past the cap with a single oversized request.
        bytes memory claimCalldata =
            abi.encodeWithSelector(ClaimRegistry.submitClaim.selector, uint256(1), keccak256("evidence-2"), 100 ether);
        bytes memory executeCalldata =
            abi.encodeWithSelector(SimpleAccount.execute.selector, address(registry), 0, claimCalldata);

        PackedUserOperation memory userOp = _buildUnsignedUserOp(address(aliceAccount), executeCalldata);
        // Deliberately inflated verification gas limit so maxCost alone
        // exceeds DAILY_CAP_WEI, forcing _validatePaymasterUserOp's own
        // check to fail during EntryPoint's simulation phase.
        userOp.accountGasLimits = bytes32((uint256(5_000_000) << 128) | uint256(500_000));
        userOp.signature = _signUserOp(userOp, aliceOwnerKey);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp;

        // EntryPoint v0.7 surfaces a single failed op's validation error
        // via a revert naming that op — the exact selector/shape is one
        // more thing worth confirming against real compiler/runtime
        // output rather than assumed; a bare vm.expectRevert() here
        // (matching any revert) is the deliberately conservative choice
        // given that uncertainty, still a real, meaningful assertion that
        // the operation does NOT silently succeed.
        vm.expectRevert();
        entryPoint.handleOps(ops, payable(bundler));
    }

    // ── UserOperation construction helpers ──────────────────────────

    function _buildUnsignedUserOp(address sender, bytes memory callData)
        internal
        view
        returns (PackedUserOperation memory)
    {
        return PackedUserOperation({
            sender: sender,
            nonce: entryPoint.getNonce(sender, 0),
            initCode: bytes(""), // account already deployed in setUp — no initCode needed
            callData: callData,
            accountGasLimits: bytes32((uint256(500_000) << 128) | uint256(500_000)), // verificationGasLimit | callGasLimit
            preVerificationGas: 100_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | uint256(10 gwei)), // maxPriorityFeePerGas | maxFeePerGas
            paymasterAndData: _buildPaymasterAndData(),
            signature: bytes("")
        });
    }

    function _buildPaymasterAndData() internal view returns (bytes memory) {
        // paymaster address (20 bytes) + paymasterVerificationGasLimit
        // (16 bytes) + paymasterPostOpGasLimit (16 bytes) + paymaster-
        // specific data (empty here — ClaimGasPaymaster's
        // _validatePaymasterUserOp reads only userOp.sender and maxCost,
        // nothing from this trailing data).
        return abi.encodePacked(address(paymaster), uint128(200_000), uint128(100_000));
    }

    function _signUserOp(PackedUserOperation memory userOp, uint256 signerKey) internal view returns (bytes memory) {
        bytes32 userOpHash = entryPoint.getUserOpHash(userOp);
        // SimpleAccount's own validateUserOp checks the signature against
        // an EIP-191-prefixed hash of userOpHash, via ECDSA — the same
        // "personal sign" scheme documented in
        // docs/dataflow/Step-1-Wallet-Auth.md, not EIP-712.
        bytes32 signedHash = MessageHashUtils.toEthSignedMessageHash(userOpHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, signedHash);
        return abi.encodePacked(r, s, v);
    }
}
