# DICS v2 — ClaimRegistry (UUPS) + Local Besu Network

This is the concrete first build slice: an upgradeable, pausable, rate-limited
`ClaimRegistry` contract, its upgrade-safety tests, and a local 4-node IBFT2.0
Besu network to deploy and test it against before touching the shared
private-network instance.

## 1. Run the local Besu network

```bash
cd besu-network
chmod +x generate-network.sh
./generate-network.sh
# Rename the four generated ./networkFiles/keys/<address> directories to
# validator1..validator4 (see note at the bottom of docker-compose.yml)
docker compose up -d
docker compose logs -f validator1   # confirm blocks are being produced
```

Verify it's alive:
```bash
curl -X POST --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  -H "Content-Type: application/json" http://localhost:8545
```

## 2. Install contract dependencies

**This project runs on OpenZeppelin v5.7.x** (migrated from v4.9.x — see
`docs/Project-1-Smart-Contracts-Explained.md` for the full migration
notes and per-file confidence levels, since not every file's migration
carries the same certainty).

**Pin the exact commit hash, not just the tag.** During this migration,
the same `DICSGovernor.sol`/`DICSGovernanceToken.sol` override targets
were reported differently across build attempts — the evidence pointed
to the installed commit shifting between `forge install` runs even
though the tag requested was the same. After `forge install` below,
run `git -C lib/openzeppelin-contracts rev-parse HEAD` (and the same for
`openzeppelin-contracts-upgradeable`) and record the exact commit hash
in project documentation/CI config, so a future `forge install` or CI
run can't silently drift onto a different commit under the same tag:

```bash
cd smart-contracts
forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v5.7.0
forge install OpenZeppelin/openzeppelin-contracts@v5.7.0
```

Add to `foundry.toml`:
```toml
remappings = [
  "@openzeppelin/contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/contracts/",
  "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/"
]
```

## 3. Run tests locally first (Anvil, not Besu)

```bash
forge test --match-contract ClaimRegistryUpgradeTest -vvv
forge coverage --match-contract ClaimRegistryUpgradeTest
```

All five tests should pass:
- `test_StateSurvivesUpgrade` — proxy state intact after upgrading implementation
- `test_RevertWhen_NonUpgraderCallsUpgrade` — upgrade authorization enforced
- `test_RevertWhen_PausedRejectsSubmitClaim` — pause actually halts state-changing calls
- `test_RevertWhen_ClaimExceedsRateLimitWindow` — rolling-window cap enforced
- `test_RescueForeignToken_RevertsOnPayoutToken` — recovery function can't touch the payout token

## 4. Deploy to the local Besu network

Point Foundry's deploy script (from the earlier deployment module,
`script/Deploy.s.sol`) at Besu instead of Anvil:

```bash
forge script script/Deploy.s.sol \
  --rpc-url http://localhost:8545 \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --broadcast
```

Deploy sequence for the upgradeable pattern specifically:
1. Deploy `ClaimRegistry` implementation (no constructor logic runs — see `_disableInitializers()`).
2. Deploy `ERC1967Proxy`, pointing at the implementation, calling `initialize(...)` in the same transaction.
3. All subsequent calls go through the proxy address — that's the address your backend, indexer, and frontend use, not the implementation address.

## 5. Role wiring — this is the part that matters most

`initialize()` grants `DEFAULT_ADMIN_ROLE`, `ADMIN_ROLE`, and `UPGRADER_ROLE`
to whatever address you pass as `timelockAdmin`. **That argument must be a
deployed `TimelockController` address, not the deployer EOA and not a raw
Safe address.**

Recommended wiring, using OpenZeppelin's `TimelockController` directly
(no need to write a custom timelock):

```
1. Deploy a Gnosis Safe with your admin signers (N-of-M threshold).
2. Deploy TimelockController:
     proposers = [SafeAddress]          // only the Safe can queue actions
     executors = [SafeAddress]          // or address(0) for "anyone can execute once ready"
     cancellers = [SeparateSafeAddress] // a DIFFERENT signer set — see design note below
     admin      = address(0)            // renounce timelock self-admin after setup
3. Deploy ClaimRegistry implementation + proxy, passing
   initialize(timelockAdmin = TimelockControllerAddress, ...).
4. Grant PAUSER_ROLE separately to individual fast-response signers or a
   low-threshold Safe — deliberately NOT the same slow path as ADMIN_ROLE.
5. Grant UNDERWRITER_ROLE to the underwriter Safe (a distinct multisig from
   the admin Safe).
6. Grant ORACLE_ROLE to the oracle adapter's signing address.
7. Confirm the deployer EOA holds none of these roles once wiring is
   complete — run the role-setup verification script from the deployment
   module and fail loudly if it doesn't hold.
```

**Cancellation authority** (from the standard toolkit): give `CANCELLER_ROLE`
on the `TimelockController` to a *different* Safe than the one holding
`PROPOSER_ROLE`. This is what makes "someone can stop a malicious queued
transaction" real rather than theoretical — if the same signers propose and
can cancel, a compromise of that one signer set defeats the whole safeguard.

## 6. InsurancePolicy.sol and OracleAdapter.sol (added in this slice)

**`InsurancePolicy.sol`** — same UUPS/Pausable/AccessControl pattern as
ClaimRegistry. Key addition: `isClaimEligible(policyId, claimant, amount,
atTime)` — a single view call that checks the policy is active, the caller
is the actual policyholder, and the claimed amount doesn't exceed coverage.
This is the function `ClaimRegistry.submitClaim` should call before
accepting a claim — **that wiring is not yet added to ClaimRegistry**, and
is the natural next step (see open items below). `POLICY_MANAGER_ROLE` is
deliberately a distinct role/Safe from ClaimRegistry's `UNDERWRITER_ROLE` —
registering a policy and approving a claim against it should never be
authorized by the same signer set.

**`OracleAdapter.sol`** — this is what `ClaimRegistry.ORACLE_ROLE` should
actually be granted to, instead of an EOA. It verifies an EIP-712 typed,
ECDSA-signed `OracleResponse` (bound to a specific `claimId` + `requestId`,
with an expiry window and adapter-level replay protection) before calling
`ClaimRegistry.recordOracleVerification`. Submission is permissionless —
any relayer can submit a validly signed response — because the security
guarantee comes from the signature, not from restricting the caller; this
is the standard signed-message relay pattern. Signer authorization
(`ORACLE_SIGNER_ROLE`) is grant/revoke-able independently, so a suspected-
compromised oracle key can be revoked immediately without a timelock delay,
while granting a *new* signer still goes through the normal `ADMIN_ROLE`
(timelock) path.

Deploy/wire order for this slice:
```
1. Deploy ClaimRegistry (implementation + proxy) — as before.
2. Deploy InsurancePolicy (implementation + proxy), initialize(timelock).
3. Deploy OracleAdapter (implementation + proxy),
   initialize(timelock, claimRegistryProxyAddress, responseValidityWindow).
4. On ClaimRegistry: grant ORACLE_ROLE to the OracleAdapter's PROXY address
   (not the implementation address, and not the oracle's own signing key).
5. On OracleAdapter: grant ORACLE_SIGNER_ROLE to the actual off-chain
   oracle service's signing address.
6. On InsurancePolicy: grant POLICY_MANAGER_ROLE to the business-ops Safe.
```

## 7. What's still open after this slice

- **ClaimRegistry does not yet call `InsurancePolicy.isClaimEligible`** —
  `submitClaim` currently accepts any `policyId` without checking it
  against InsurancePolicy at all. Wiring this in means ClaimRegistry needs
  a reference to the InsurancePolicy proxy address (there's already an
  unused `policyRegistry` storage variable reserved for exactly this) and
  a cross-contract call inside `submitClaim`. Left unwired here rather than
  silently modifying the previously-delivered ClaimRegistry.sol without
  being asked — flagging it explicitly as the next concrete step.
- **Cumulative coverage consumption is not tracked.** `isClaimEligible`
  checks a single claim against total coverage, but doesn't know how much
  of that coverage prior claims on the same policy have already consumed.
  Needs a design decision: does InsurancePolicy track "coverage remaining"
  itself (requiring ClaimRegistry to report back on payout), or does
  ClaimRegistry sum its own `policyClaims[policyId]` array to compute
  consumption at check-time? Not decided yet — noted rather than guessed.
- **Monitoring/alerting on Timelock queued-transaction events** and on
  `OracleAdapter`'s `VerificationSubmitted`/role-revocation events is not
  wired up — both emit the events needed, nothing is watching them yet.
- **Terraform/Ansible provisioning for a shared, persistent Besu instance**
  (vs. this local Docker Compose network) is a separate, not-yet-built
  piece.
- **The off-chain oracle service itself** (the thing that actually signs
  `OracleResponse` payloads) doesn't exist yet — only the on-chain
  verification side is built.
