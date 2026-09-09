
### ClaimRegistry.sol
UUPS upgradeable, AccessControl roles split so pausing is fast (PAUSER_ROLE) but unpausing and upgrades go through ADMIN_ROLE/UPGRADER_ROLE (intended to be a TimelockController), <br>
a rolling-window rate limit on total payouts, <br>
oracle-response replay protection, and <br>
the two narrow fund-recovery functions from the earlier design (foreign-token rescue that explicitly can't touch the payout token; <br>
stuck-payout release that only ever pays the claim's own claimant, never a caller-supplied address).<br>
### ClaimRegistryUpgrade.t.sol 
Foundry tests proving state survives an actual upgrade, that only UPGRADER_ROLE can trigger one, that pause actually blocks state changes, and that the rate limit and rescue restrictions hold.
### docker-compose.yml + generate-network.sh + ibftConfigFile.json
a real 4-node IBFT2.0 Besu network you can bring up locally, using Besu's own operator generate-blockchain-config tool rather than hand-crafted keys (which is the correct way to do this — hand-rolling IBFT extraData is a common source of subtle bugs).
