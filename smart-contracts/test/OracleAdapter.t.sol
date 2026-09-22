// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OracleAdapter} from "../contracts/OracleAdapter.sol";
import {MockClaimRegistrySink} from "../contracts/mocks/MockClaimRegistrySink.sol";

// MockClaimRegistrySink now lives in contracts/mocks/ so it can be reused
// by script/DeployIntegrationFixture.s.sol for the JS integration test —
// see oracle-service/test/oracle.integration.test.js.

contract OracleAdapterTest is Test {
    OracleAdapter public adapter;
    MockClaimRegistrySink public sink;

    address public timelock = makeAddr("timelock");
    uint256 public oracleSignerKey = 0xA11CE;
    address public oracleSigner;
    address public relayer = makeAddr("relayer"); // deliberately NOT a privileged role

    uint256 public constant VALIDITY_WINDOW = 300; // 5 minutes

    function setUp() public {
        oracleSigner = vm.addr(oracleSignerKey);
        vm.label(oracleSigner, "OracleSigner");

        sink = new MockClaimRegistrySink();

        OracleAdapter implementation = new OracleAdapter();
        bytes memory initData = abi.encodeWithSelector(
            OracleAdapter.initialize.selector, timelock, address(sink), VALIDITY_WINDOW
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
        adapter = OracleAdapter(address(proxy));

        bytes32 oracleSignerRole = adapter.ORACLE_SIGNER_ROLE();
        vm.prank(timelock);
        adapter.grantRole(oracleSignerRole, oracleSigner);
    }

    function _sign(OracleAdapter.OracleResponse memory response, uint256 signerKey)
        internal
        view
        returns (bytes memory signature)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                adapter.oracleResponseTypehash(),
                response.claimId,
                response.requestId,
                response.approved,
                response.timestamp
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", adapter.domainSeparatorV4(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function test_ValidSignature_ForwardsToClaimRegistry() public {
        OracleAdapter.OracleResponse memory response = OracleAdapter.OracleResponse({
            claimId: 42,
            requestId: keccak256("req-1"),
            approved: true,
            timestamp: block.timestamp
        });
        bytes memory sig = _sign(response, oracleSignerKey);

        vm.prank(relayer); // anyone can relay — security is in the signature, not the caller
        adapter.submitVerification(response, sig);

        assertEq(sink.callCount(), 1);
        assertEq(sink.lastClaimId(), 42);
        assertTrue(sink.lastApproved());
    }

    function test_RevertWhen_SignerNotAuthorized() public {
        uint256 unauthorizedKey = 0xBAD;
        OracleAdapter.OracleResponse memory response = OracleAdapter.OracleResponse({
            claimId: 1,
            requestId: keccak256("req-2"),
            approved: true,
            timestamp: block.timestamp
        });
        bytes memory sig = _sign(response, unauthorizedKey);

        vm.expectRevert(OracleAdapter.UnauthorizedSigner.selector);
        adapter.submitVerification(response, sig);
    }

    function test_RevertWhen_RequestIdReplayed() public {
        OracleAdapter.OracleResponse memory response = OracleAdapter.OracleResponse({
            claimId: 1,
            requestId: keccak256("req-3"),
            approved: true,
            timestamp: block.timestamp
        });
        bytes memory sig = _sign(response, oracleSignerKey);

        adapter.submitVerification(response, sig);

        vm.expectRevert(OracleAdapter.RequestAlreadyUsed.selector);
        adapter.submitVerification(response, sig);
    }

    function test_RevertWhen_ResponseExpired() public {
        OracleAdapter.OracleResponse memory response = OracleAdapter.OracleResponse({
            claimId: 1,
            requestId: keccak256("req-4"),
            approved: true,
            timestamp: block.timestamp
        });
        bytes memory sig = _sign(response, oracleSignerKey);

        vm.warp(block.timestamp + VALIDITY_WINDOW + 1);

        vm.expectRevert(OracleAdapter.ResponseExpired.selector);
        adapter.submitVerification(response, sig);
    }

    function test_RevertWhen_TimestampFromFuture() public {
        OracleAdapter.OracleResponse memory response = OracleAdapter.OracleResponse({
            claimId: 1,
            requestId: keccak256("req-5"),
            approved: true,
            timestamp: block.timestamp + 1_000
        });
        bytes memory sig = _sign(response, oracleSignerKey);

        vm.expectRevert(OracleAdapter.ResponseFromFuture.selector);
        adapter.submitVerification(response, sig);
    }

    function test_RevertWhen_Paused() public {
        bytes32 pauserRole = adapter.PAUSER_ROLE();
        vm.prank(timelock);
        adapter.grantRole(pauserRole, timelock);
        vm.prank(timelock);
        adapter.pause();

        OracleAdapter.OracleResponse memory response = OracleAdapter.OracleResponse({
            claimId: 1,
            requestId: keccak256("req-6"),
            approved: true,
            timestamp: block.timestamp
        });
        bytes memory sig = _sign(response, oracleSignerKey);

        vm.expectRevert();
        adapter.submitVerification(response, sig);
    }

    function test_RevertWhen_RevokedSignerReusesKey() public {
        bytes32 oracleSignerRole = adapter.ORACLE_SIGNER_ROLE();
        vm.prank(timelock);
        adapter.revokeRole(oracleSignerRole, oracleSigner);

        OracleAdapter.OracleResponse memory response = OracleAdapter.OracleResponse({
            claimId: 1,
            requestId: keccak256("req-7"),
            approved: true,
            timestamp: block.timestamp
        });
        bytes memory sig = _sign(response, oracleSignerKey);

        vm.expectRevert(OracleAdapter.UnauthorizedSigner.selector);
        adapter.submitVerification(response, sig);
    }
}
