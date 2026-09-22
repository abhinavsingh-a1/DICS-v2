// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ClaimRegistry} from "../contracts/ClaimRegistry.sol";
import {InsurancePolicy} from "../contracts/InsurancePolicy.sol";
import {TestPayoutToken} from "../contracts/mocks/TestPayoutToken.sol";

/// @notice Deploys a full InsurancePolicy + ClaimRegistry + test token
///         stack, registers one active policy, and funds ClaimRegistry
///         for payouts — for indexer/test/indexer.integration.test.js.
///         Same "throwaway deployer-as-admin, not a production template"
///         caveat as DeployIntegrationFixture.s.sol.
contract DeployIndexerFixture is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("INTEGRATION_DEPLOYER_PRIVATE_KEY");
        address claimant = vm.envAddress("INTEGRATION_CLAIMANT_ADDRESS");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        TestPayoutToken token = new TestPayoutToken();

        InsurancePolicy policyImpl = new InsurancePolicy();
        bytes memory policyInit = abi.encodeWithSelector(InsurancePolicy.initialize.selector, deployer);
        ERC1967Proxy policyProxy = new ERC1967Proxy(address(policyImpl), policyInit);
        InsurancePolicy policy = InsurancePolicy(address(policyProxy));

        // No oracle wiring needed for this fixture — the indexer test
        // only needs to observe ClaimSubmitted/ClaimStatusChanged/
        // ClaimPayout events, which the underwriter role (granted to
        // the deployer below) can drive directly via setClaimStatus.
        // The oracle signature-verification path is already covered
        // separately by oracle-service's own integration test against
        // the real OracleAdapter — no need to duplicate that here.
        ClaimRegistry registryImpl = new ClaimRegistry();
        bytes memory registryInit = abi.encodeWithSelector(
            ClaimRegistry.initialize.selector,
            deployer,
            address(token),
            address(policy),
            1_000_000 ether, // maxPayoutPerClaim
            10_000_000 ether, // maxPayoutPerWindow
            1 days
        );
        ERC1967Proxy registryProxy = new ERC1967Proxy(address(registryImpl), registryInit);
        ClaimRegistry registry = ClaimRegistry(address(registryProxy));

        registry.grantRole(registry.UNDERWRITER_ROLE(), deployer);
        policy.grantRole(policy.POLICY_MANAGER_ROLE(), deployer);

        policy.registerPolicy(1, claimant, 0, type(uint40).max, 100_000 ether, keccak256("fixture-policy"));

        // Premium is deliberately left unconfigured for this fixture —
        // InsurancePolicy.isPremiumCurrent() defaults an unconfigured
        // policy to "exempt" (see InsurancePolicy.sol's own comment on
        // that design choice), so this indexer-focused fixture needed no
        // changes at all when premium enforcement was added to
        // ClaimRegistry.submitClaim. Premium-specific behavior is tested
        // separately in test/Premium.t.sol.

        require(token.transfer(address(registry), 1_000_000 ether), "transfer failed");

        vm.stopBroadcast();

        string memory json = "fixture";
        vm.serializeAddress(json, "claimRegistry", address(registryProxy));
        vm.serializeAddress(json, "insurancePolicy", address(policyProxy));
        vm.serializeAddress(json, "testToken", address(token));
        vm.serializeUint(json, "policyId", 1);
        string memory finalJson = vm.serializeUint(json, "chainId", block.chainid);
        vm.writeJson(finalJson, "./indexer-fixture.json");

        console2.log("Indexer fixture deployed:");
        console2.log("  ClaimRegistry (proxy):", address(registryProxy));
        console2.log("  InsurancePolicy (proxy):", address(policyProxy));
        console2.log("  TestPayoutToken:", address(token));
    }
}
