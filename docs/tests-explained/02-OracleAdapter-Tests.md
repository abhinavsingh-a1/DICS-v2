# 02 — `test/OracleAdapter.t.sol` Explained

**Read `00-Introduction.md` and `08-Mock-MockClaimRegistrySink.md` first**
— this file uses that mock throughout.

## Purpose of this file

Tests `OracleAdapter.sol`'s signature verification and replay/expiry
protection — the part of the system that turns an off-chain oracle
decision into something the blockchain can trust. Uses
`MockClaimRegistrySink` instead of a real `ClaimRegistry`, for the
reasons explained in that document.

## `setUp()` and the `_sign` helper — what they build, and why every line is there

```solidity
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
```

- **`uint256 public oracleSignerKey = 0xA11CE;`** (a state variable,
  declared above `setUp()`) — this is a real private key value, chosen
  as an easy-to-recognize hex pattern. **Why a raw private key is
  needed at all, unlike every other test file's addresses:** every
  other test file only ever needs *addresses* (`makeAddr("...")`
  produces one without any matching key), because nothing else in this
  project needs to *sign* anything as part of a test. This file is the
  exception — proving signature verification works means a test must
  be able to produce a real, valid signature, which requires an actual
  private key, not just an address.
- **`oracleSigner = vm.addr(oracleSignerKey);`** — derives the address
  that corresponds to that private key. This is *why* `vm.addr` exists
  as a separate cheatcode from `makeAddr`: `makeAddr` can hand you an
  address, but not a key you could sign with; `vm.addr` goes the other
  direction, key-to-address, which is exactly what's needed here since
  the key is what's fixed and known.
- **`sink = new MockClaimRegistrySink();`** — see
  `08-Mock-MockClaimRegistrySink.md` for the full reasoning; in short,
  this is what lets this file test `OracleAdapter` without needing a
  working `ClaimRegistry`.
- **`bytes32 oracleSignerRole = ...` before the `prank`** — same
  single-shot-prank reasoning as every other file; see
  `00-Introduction.md`.

```solidity
function _sign(OracleAdapter.OracleResponse memory response, uint256 signerKey)
    internal view returns (bytes memory signature)
{
    bytes32 structHash = keccak256(abi.encode(
        adapter.oracleResponseTypehash(), response.claimId, response.requestId,
        response.approved, response.timestamp
    ));
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", adapter.domainSeparatorV4(), structHash));
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
    signature = abi.encodePacked(r, s, v);
}
```

**Why this helper function exists, and what would be left out without
it:** every single test in this file needs a signed `OracleResponse`,
and the exact recipe for producing a valid one — building the struct
hash, wrapping it in the EIP-712 domain separator, signing the result —
is genuinely complex and has to match `OracleAdapter.sol`'s own
verification logic *exactly*, byte for byte. Writing this out seven
separate times (once per test) wouldn't just be repetitive — it would
be a real risk, since a small inconsistency between two copies could
make a test pass or fail for the wrong reason. This function is the
**one, single source of truth** for "how does a valid signature get
produced," used by every test. It mirrors, deliberately, what a real
off-chain oracle service does — see `oracle-service/src/signer.js` in
this project, which performs the same construction in JavaScript for
the real system.

## Every test, explained

### `test_ValidSignature_ForwardsToClaimRegistry`
**Verifies:** a properly signed, authorized response is accepted and
correctly forwarded to the sink.
**Why this test exists:** this is the "does the whole mechanism work at
all" test — every other test in this file proves a specific *failure*
case; this is the one proving the *success* case actually succeeds.
**Data flow:** builds an `OracleResponse` for claim `42`; signs it with
`oracleSignerKey` via `_sign`; `vm.prank(relayer)` — note `relayer` was
never granted any role at all, deliberately, to prove submission is
permissionless (see the comment in the source: "anyone can relay —
security is in the signature, not the caller"); calls
`adapter.submitVerification(response, sig)`; then checks `sink.callCount() == 1`,
`sink.lastClaimId() == 42`, and `sink.lastApproved() == true` —
confirming the mock actually received the forwarded call with the
correct data.

### `test_RevertWhen_SignerNotAuthorized`
**Verifies:** a *validly formed* signature — cryptographically correct,
just produced by the wrong private key — is rejected.
**Why this test exists:** proves `OracleAdapter` checks *who* signed,
not merely *whether* something is signed. Without this test, a
contract bug that verified the signature's mathematical validity but
forgot to check the signer held `ORACLE_SIGNER_ROLE` would pass every
other test.
**Data flow:** signs the exact same kind of response, but with
`unauthorizedKey = 0xBAD` instead of `oracleSignerKey` — the signature
itself is completely valid, it's just from an address nobody ever
granted the role to.

### `test_RevertWhen_RequestIdReplayed`
**Verifies:** submitting the identical, already-used `(response, signature)`
pair a second time fails.
**Why this test exists:** this is the test proving the replay-protection
guarantee described throughout this project's documentation actually
holds in code, not just in design intent.
**Data flow:** calls `submitVerification` once successfully (no prank
needed — same reasoning as the permissionless-relay point above), then
calls it again with the exact same arguments — the second call reverts
because `usedRequestIds[requestId]` is now `true`.

### `test_RevertWhen_ResponseExpired`
**Verifies:** a signature that was valid when created is rejected if
submitted too late.
**Why this test exists:** without an expiry window, a stale signed
verification could sit unused indefinitely and be submitted long after
its underlying real-world event was even relevant — this test proves
that window is actually enforced.
**Data flow:** `vm.warp(block.timestamp + VALIDITY_WINDOW + 1)` moves
the simulated clock forward past the response's validity window
*before* submission — this is a cheatcode doing something no real
transaction could: letting the test control time directly, rather than
waiting for real time to pass.

### `test_RevertWhen_TimestampFromFuture`
**Verifies:** a response claiming a timestamp that hasn't happened yet
is rejected.
**Why this test exists:** without this check, a compromised or buggy
oracle signer could pre-sign responses timestamped arbitrarily far in
the future, effectively pre-approving claims before their triggering
events occur — this test proves that path is closed.
**Data flow:** builds a response with `timestamp: block.timestamp + 1_000`
— a timestamp that, from the test's perspective, is genuinely still in
the future — and confirms submission reverts immediately, without
needing any time warp at all (unlike the expiry test above).

### `test_RevertWhen_Paused`
**Verifies:** the emergency pause blocks verification submission, even
with a perfectly valid signature.
**Why this test exists:** same reasoning as
`InsurancePolicy.t.sol`'s equivalent test — proves the pause mechanism
actually reaches this function, not just other ones.

### `test_RevertWhen_RevokedSignerReusesKey`
**Verifies:** once `ORACLE_SIGNER_ROLE` is revoked from an address,
signatures from that same private key stop being accepted — even
though the signature math itself is unaffected by the revocation.
**Why this test exists:** this is the test that proves role revocation
is a *real, live* security control, checked at verification time — not
a one-time check performed only when the role was originally granted.
Without it, revoking a compromised oracle key would give a false sense
of security while old, still-valid-looking signatures kept working.
**Data flow:** revokes the role first (reading `ORACLE_SIGNER_ROLE()`
into a local variable before the `prank`, same pattern as everywhere
else), *then* signs a brand-new response with the same, now-revoked
key — proving this isn't about an old signature being replayed
(`test_RevertWhen_RequestIdReplayed` already covers that), but about a
freshly-produced signature from a key that's no longer trusted.
