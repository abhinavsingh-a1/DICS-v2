# 13 — Frontend: `api/contract.js` Additions

Everything in this file runs in the person's own browser, using their
own wallet. Nothing here goes through the backend — a fact worth
holding onto while reading, since it explains almost every design
choice below.

## What is the purpose of this file (the new parts)?

The original version of this file could only do one thing:
`submitClaimOnChain`. This project added two entirely new user actions
that also need to happen directly on-chain, signed by the user's own
wallet: subscribing to a policy, and paying/renewing a premium. This
file is where those two new capabilities live, plus one read-only
helper (`getPolicyTemplate`) and a shared `getReadProvider` used by it.

**If this file's new functions didn't exist:** `BuyPolicy.jsx` and
`PremiumStatusBadge.jsx` (documented in `14`) would have no way to
actually submit the transactions their buttons are meant to trigger —
they'd be buttons connected to nothing.

## Why is there a *separate* `getReadProvider()` function, when `submitClaimOnChain` already gets a provider from the caller?

Look at the difference in how each is used:

```js
// submitClaimOnChain — needs a SIGNER, passed in by the caller
export async function submitClaimOnChain(signer, policyId, merkleRoot, amountEther) { ... }

// getPolicyTemplate — builds its OWN read-only PROVIDER internally
export async function getPolicyTemplate(templateId) {
  const provider = getReadProvider();
  ...
}
```

A **signer** can sign transactions — it represents a specific wallet
that has agreed to pay gas and approve an action. A **provider** can
only *read* chain data; it has no private key and can't authorize
anything. `submitClaimOnChain` needs a signer because submitting a
claim changes state and must come from a specific, wallet-approved
identity. `getPolicyTemplate` only reads a template's price and
coverage — data that's the same no matter who's asking — so it doesn't
need a wallet connected at all.

**Why this matters for the actual user experience:** it's what lets
`BuyPolicy.jsx` show the catalog of plans to someone who hasn't
connected a wallet yet. If every chain read required a signer, browsing
plans would force a wallet connection before a person could even see
what's on offer — worse UX for no real benefit, since nothing about
looking at prices needs anyone's identity or approval.

**What would happen without this separation:** either every function
in this file would need a connected wallet just to read public data
(a real usability cost), or `getPolicyTemplate` would have to duplicate
`getReadProvider`'s three lines of setup inline — small in this file,
but a real problem the moment a second or third read-only function
needed the same setup, which is exactly why it was factored out once
here rather than copy-pasted.

## Why does `requireAddress` exist as its own tiny function, rather than checking `if (!ADDRESS)` inline in every function?

```js
function requireAddress(address, envVarName) {
  if (!address || address === ethers.ZeroAddress) {
    throw new Error(`${envVarName} is not configured.`);
  }
}
```

Every single write function in this file (`submitClaimOnChain`,
`subscribeToPolicyOnChain`, `payPremiumOnChain`, `getPolicyTemplate`)
needs to check that its required contract address was actually
configured before trying to use it — an empty or all-zero address
(`0x000...000`, `ethers.ZeroAddress`) is what the `.env.example`
template files ship with by default, and would otherwise fail deep
inside `ethers.js` with a much more confusing error message.

**What's actually saved by pulling this into one function:** not just
typing — consistency. If this check were written out separately four
times, it would be easy for one copy to drift (checking for `undefined`
but forgetting the all-zeros case, say), producing a bug that only
shows up for that one function. One shared implementation means the
check is either right everywhere or wrong everywhere, never
inconsistently right in three places and subtly wrong in a fourth.

## Data flow inside `subscribeToPolicyOnChain` — with concrete values

Using Alice buying the Premium plan, matching the worked example in
`docs/dataflow/Step-2-Buy-Policy-Premium-Payment.md` exactly:

- **Input:** `signer` (Alice's connected wallet, address
  `0x1111111111111111111111111111111111AAAA`), `templateId = 3`,
  `premiumAmountEther = "33"` (a string, from the backend's catalog
  response converted via `ethers.formatEther`)
- **Line by line:**
  1. `requireAddress(INSURANCE_POLICY_ADDRESS, ...)` and the same for
     `STABLECOIN_ADDRESS` — fail fast if either is misconfigured, before
     any transaction is attempted.
  2. `const stableCoin = new ethers.Contract(STABLECOIN_ADDRESS, ERC20_ABI, signer)`
     — builds a callable object for the dUSD token contract, using
     Alice's signer so any calls through it are signed by her wallet.
  3. `const amountWei = ethers.parseEther("33")` — converts the
     human-readable string `"33"` into the actual on-chain integer
     `33000000000000000000`. This is the **exact inverse** operation of
     `formatEther`, used everywhere else in this integration to go the
     other direction (see document `11`'s explanation) — `parseEther`
     for "human string → chain integer", `formatEther` for
     "chain integer → human string." Mixing these up in either direction
     is a common, easy mistake worth naming explicitly.
  4. `const approveTx = await stableCoin.approve(INSURANCE_POLICY_ADDRESS, amountWei)`
     — this is Alice's wallet popping up, asking her to approve
     `InsurancePolicy` spending exactly 33 dUSD on her behalf. `approve`
     is a plain EIP-20 function (see `docs/dataflow/00-Overview-and-Index.md`
     on EIP-20) — nothing project-specific about it.
  5. `const approveReceipt = await approveTx.wait()` — pauses execution
     until that approval transaction is actually mined, not just
     submitted. **Why this matters:** without waiting, the code would
     move on to step 6 while the approval might still be pending,
     and `subscribeToPolicy`'s internal `safeTransferFrom` could then
     fail because the allowance isn't set yet from the chain's point of
     view.
  6. `const policy = new ethers.Contract(INSURANCE_POLICY_ADDRESS, INSURANCE_POLICY_ABI, signer)`
     — a second contract object, this time for `InsurancePolicy` itself.
  7. `const subscribeTx = await policy.subscribeToPolicy(3)` — Alice's
     wallet pops up a *second* time, this time approving the actual
     subscription. This is the real on-chain call documented in full,
     value by value, in `docs/dataflow/Step-2-Buy-Policy-Premium-Payment.md`.
  8. `const subscribeReceipt = await subscribeTx.wait()` — same
     wait-for-mining reasoning as step 5.
- **Output:** `{ approveTxHash, subscribeTxHash }` — both transaction
  hashes, returned together so the calling page (`BuyPolicy.jsx`) can
  show the user proof of both steps, not just the final one.

## Why does the user see *two* separate wallet popups, instead of one?

This surprises people the first time they see it, so it's worth
answering directly: this isn't a bug or an inefficiency that could be
fixed with better code — it's a fundamental limit of how EIP-20 tokens
work. `approve` and `subscribeToPolicy` are two **separate transactions**
sent to two **separate contracts** (`StableCoin` and `InsurancePolicy`),
and a wallet can only sign one transaction at a time. There is no way
to bundle "approve this token spend" and "call this other contract" into
a single signature with plain EIP-20 — that's precisely the limitation
EIP-2612 (`permit`, mentioned in the data-flow documents' summary table)
exists to solve for tokens that support it, and precisely why
`ClaimGasPaymaster`/EIP-4337 (also covered there) exist to improve the
experience further for gas, not approvals. `StableCoin.sol` in this
project implements plain EIP-20 only, not EIP-2612's `permit` — so two
signatures is the genuinely correct behavior here, not a shortcut that
was missed.
