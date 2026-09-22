// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OracleAdapter} from "../contracts/OracleAdapter.sol";
import {MockClaimRegistrySink} from "../contracts/mocks/MockClaimRegistrySink.sol";

/// @notice Deploys a real OracleAdapter (behind a proxy) + a mock
///         ClaimRegistry sink to whatever RPC this script is pointed at,
///         grants ORACLE_SIGNER_ROLE to a caller-specified address, and
///         writes the deployed addresses to a JSON file so an external
///         (non-Solidity) test harness — specifically
///         oracle-service/test/oracle.integration.test.js — can pick them
///         up without duplicating ABI/bytecode in JavaScript.
/// @dev Only intended for local/Anvil integration-test use. Not the same
///      script as production deployment (which wires the real Timelock,
///      not a throwaway deployer key, as admin — see besu-network/README.md).
contract DeployIntegrationFixture is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("INTEGRATION_DEPLOYER_PRIVATE_KEY");
        address oracleSigner = vm.envAddress("INTEGRATION_ORACLE_SIGNER");
        uint256 validityWindow = vm.envOr("INTEGRATION_RESPONSE_VALIDITY_WINDOW", uint256(300));

        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        MockClaimRegistrySink sink = new MockClaimRegistrySink();

        OracleAdapter implementation = new OracleAdapter();
        bytes memory initData = abi.encodeWithSelector(
            OracleAdapter.initialize.selector,
            deployer, // deployer itself is admin for this throwaway fixture — never do this in a real deployment
            address(sink),
            validityWindow
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
        OracleAdapter adapter = OracleAdapter(address(proxy));

        adapter.grantRole(adapter.ORACLE_SIGNER_ROLE(), oracleSigner);

        vm.stopBroadcast();

        string memory json = "fixture";
        vm.serializeAddress(json, "oracleAdapter", address(proxy));
        vm.serializeAddress(json, "oracleAdapterImplementation", address(implementation));
        vm.serializeAddress(json, "claimRegistrySink", address(sink));
        string memory finalJson = vm.serializeUint(json, "chainId", block.chainid);
        vm.writeJson(finalJson, "./integration-fixture.json");

        console2.log("Integration fixture deployed:");
        console2.log("  OracleAdapter (proxy):", address(proxy));
        console2.log("  MockClaimRegistrySink:", address(sink));
    }
}
