# 14 — Frontend UI: `BuyPolicy.jsx`, `PremiumStatusBadge.jsx`, and the `Dashboard`/`App` Wiring

This document includes two real mistakes made and caught while building
these files, explained in full rather than quietly fixed — seeing what
actually goes wrong, and how it's found, is worth more to a junior
developer than a description of only the final, correct code.

## `pages/BuyPolicy.jsx`

### What is the purpose of this file?

This is the page where a person actually becomes a policyholder — it
shows the three catalog plans (fetched from the backend's
`GET /policies/catalog`, see document `11`) and lets them subscribe to
one. Before this file existed, there was no page anywhere in this
frontend that could create a new policy at all — every other page
assumed a policy already existed.

**If this file didn't exist:** the entire "buy a policy" half of this
project's user journey (see the earlier "what can a user do from the
frontend" discussion) would remain contract-only — genuinely
unreachable except by someone calling `subscribeToPolicy` directly
through a block explorer or a script.

### Real mistake #1: `require('ethers')` instead of `import`

The first version of this file's `formatWei` helper was written as:

```js
function formatWei(weiString) {
  const { ethers } = require('ethers');
  return ethers.formatEther(weiString);
}
```

**Why this is wrong, and why it wasn't obviously wrong at a glance:**
`require(...)` is Node.js's older module-loading syntax (CommonJS).
This project's frontend is built with Vite, which uses ES Modules
(`import`/`export`) — the modern JavaScript standard, and the *only*
module system that actually works in a browser without extra tooling.
`require` simply doesn't exist as a global function in that environment
— code using it would fail immediately the moment this file loaded,
with an error like `require is not defined`.

**Why it's an easy mistake to make:** if you've written any Node.js
backend code (or copied a snippet from an older tutorial), `require` is
completely natural to reach for — it's not a typo, it's using the wrong
module system's syntax for the environment you're actually in.

**The fix:**

```js
import { ethers } from 'ethers';

function formatWei(weiString) {
  return ethers.formatEther(weiString);
}
```

A single top-level `import` at the top of the file, used directly —
`ethers` was already going to be needed inside `handleSubscribe` too
(for `ethers.BrowserProvider`), so this one import serves both.

**How this kind of mistake gets caught in a real project:** either the
page crashes the instant it renders (loud, easy to notice) or, in a
stricter setup, a linter configured to catch undefined globals flags it
before the code ever runs. Here, it was caught by re-reading the file
carefully rather than assuming a first draft was correct — the same
habit worth building for your own code.

### Data flow inside `handleSubscribe`

- **Input:** `template` — one object from the catalog array, e.g.
  `{ template_id: 3, coverage_amount_wei: "10000000000000000000000", premium_amount_per_period_wei: "33000000000000000000", period_seconds: 2592000, term_seconds: 31536000 }`
- **Line by line:**
  1. `setError(null); setResult(null);` — clears any previous
     error/result before starting a new attempt, so a stale message
     from a *previous* failed subscription doesn't linger on screen
     confusingly next to a *new* attempt's progress.
  2. `setSubscribing(template.template_id)` — records *which* plan's
     button was clicked, not just "something is loading." This is what
     lets the button rendering logic
     (`subscribing === t.template_id ? 'Confirm in wallet…' : 'Subscribe'`)
     show the loading state on the *specific* button that was clicked,
     while the other two plans' buttons stay showing "Subscribe" (still
     disabled via `disabled={subscribing !== null}`, but not misleadingly
     also saying "Confirm in wallet…" for a plan nobody clicked).
  3. `const provider = new ethers.BrowserProvider(window.ethereum)` —
     wraps whatever wallet extension is installed (MetaMask or
     otherwise) in an ethers.js-compatible interface. This is EIP-1193
     in action (see the data-flow documents' Step 1) — `window.ethereum`
     is the standardized object every wallet extension provides.
  4. `const signer = await provider.getSigner()` — gets the actual
     "can sign transactions" object for whichever account the wallet
     currently has selected.
  5. `const premiumEther = formatWei(template.premium_amount_per_period_wei)`
     — converts `"33000000000000000000"` into `"33"`, the human-readable
     form `subscribeToPolicyOnChain` expects (see document `13`).
  6. `await subscribeToPolicyOnChain(signer, template.template_id, premiumEther)`
     — the actual two-transaction flow documented fully in document `13`.
  7. `setResult({ templateId: ..., approveTxHash, subscribeTxHash })` —
     stores both hashes so the confirmation card can display them.
- **Output:** on success, the component re-renders showing the
  confirmation card with both transaction hashes. On failure at any
  point (wallet rejection, insufficient dUSD balance, network error),
  the `catch` block sets `error`, and — because of the guard
  `if (error && !templates)` at the top of the component — the catalog
  list stays visible underneath the error message, so the person can
  immediately try again without the page needing to reload.

---

## `components/PremiumStatusBadge.jsx`

### What is the purpose of this file?

A small, self-contained widget: given just a `policyId`, it fetches
that policy's premium status and shows either "paid up" or a "Pay
Premium" button. It's used inside `Dashboard.jsx`, once per claim shown,
so a person sees immediately whether the policy behind each claim is in
good standing.

**If this file didn't exist:** a person could have a policy whose
premium quietly lapsed with no visible indication anywhere in the
app — they'd only discover it the hard way, when a real claim
submission reverted with `PremiumNotCurrent` (see the smart-contract
data-flow documents) and they'd have no idea why from the UI alone.

### Real mistake #2: an error that permanently hides the retry button

The first version of this file used **one shared `error` state** for
two different kinds of failure: failing to *load* the policy's status,
and failing to *pay* the premium. The render logic started with:

```js
if (error) return <span className="error">{error}</span>;
```

**Walk through exactly what goes wrong, step by step:**
1. The component loads successfully — `status` is set, `error` is
   `null`. It renders the "Premium lapsed" message and a working "Pay
   Premium" button, as intended.
2. The person clicks the button. Their wallet pops up. They click
   "Reject" (or their transaction fails for any other reason —
   insufficient dUSD, network hiccup, anything).
3. `handlePay`'s `catch` block runs: `setError(err?.message || 'Payment failed.')`.
4. The component re-renders. Now `error` is truthy — and the very
   first line, `if (error) return ...`, fires. **The entire rest of the
   component — including the "Pay Premium" button itself — never
   renders again.**
5. The person is now stuck looking at a red error message with no
   button anywhere on the page to try again. Their only recourse is a
   full page reload, which re-mounts the component fresh (resetting
   `error` back to `null`) — a jarring, confusing dead end for what
   should be a simple "that didn't work, try again" moment.

**Why this is easy to miss when first writing the code:** the *happy
path* — successful load, successful payment — works perfectly, and it's
tempting to test only that path and call the component done. The bug
only appears on a *specific failure* (the payment attempt, not the
initial load), which is exactly the kind of case that's easy to skip
when clicking through an app manually versus deliberately thinking
through "what happens if this specific step fails partway through."

**The fix:** two separate pieces of state, `loadError` and `payError`,
so a payment failure can be shown *without* hiding the status and
button that are still perfectly valid:

```js
const [loadError, setLoadError] = useState(null);
const [payError, setPayError] = useState(null);

// ... only a LOAD failure returns early and replaces everything:
if (loadError) return <span className="error">{loadError}</span>;
if (status === null) return <span>Checking premium…</span>;

// ... a PAY failure is rendered ALONGSIDE the button, not instead of it:
return (
  <span>
    <span className="error">Premium lapsed...</span>
    <button onClick={handlePay}>Pay Premium</button>
    {payError && <span className="error">{payError}</span>}
  </span>
);
```

**The general lesson, not just this specific fix:** when a component
has more than one distinct thing that can go wrong, ask whether they
actually need to be treated the same way. Here, "I have no data to show
at all" and "I have valid data, but the last action on it failed"
are genuinely different situations that call for different UI — one
replaces the screen, the other adds a small note next to what's already
correctly showing.

### Why does the `useEffect` dependency array include `txHash`, when `txHash` isn't used to decide *what* to fetch?

```js
useEffect(() => {
  // ... fetches policy status using `policyId` ...
}, [policyId, txHash]);
```

**What this line actually causes:** React re-runs an effect whenever
any value in its dependency array changes. `policyId` is there for the
obvious reason — if the badge were ever reused for a different policy,
it should re-fetch. `txHash` is there for a subtler reason: it's set
(via `setTxHash(hash)`) at the end of a *successful* `handlePay` call.
Adding it to this array means "also re-run this fetch whenever a
payment just succeeded" — which is exactly how the badge flips from
"lapsed, pay now" to "current, paid through [date]" immediately after
payment, without needing any more explicit code to trigger that
refresh. The dependency array isn't just "what does this effect read,"
it's also a deliberate way to say "and also re-run when *this*
happens," even when the effect's own logic never directly looks at
`txHash`'s value.

---

## The `Dashboard.jsx` and `App.jsx` wiring

### Why is `PremiumStatusBadge` placed inside each *claim* card, rather than in one separate "your policies" section?

Stated directly in the code comment where it's used: there's no
`GET /policies/mine` endpoint, because `InsurancePolicy.sol` has no
function to list every policy a given address holds — a Solidity
mapping can be looked up by key, not searched by value. Building a
real "all your policies" list would need an indexer tracking
`PolicySubscribed` events by holder address, which isn't part of this
project's indexer today (a real, named gap, not hidden). Placing the
badge next to each claim uses data the page already has for another
reason (`c.policy_id`, from the claims list) to answer the one question
that matters most at that exact moment: can *this* policy currently be
claimed against.

### Why is the `/buy-policy` route deliberately *not* wrapped in `RequireAuth`, unlike every other route?

```jsx
<Route
  path="/buy-policy"
  element={
    // Deliberately NOT wrapped in RequireAuth...
    <BuyPolicy />
  }
/>
```

`RequireAuth` checks for a backend JWT session (see `AuthContext.jsx`)
— but browsing the catalog is an unauthenticated backend call
(`GET /policies/catalog`, see document `11`), and subscribing is a
direct wallet transaction that never touches the backend's session
system at all (see document `13`). Wrapping this route in `RequireAuth`
would force a person to complete an unrelated login flow (proving
they can sign an off-chain message) before they're even allowed to
*look at* what plans exist — a real, avoidable obstacle for no actual
security benefit, since nothing on this page depends on that session
existing.
