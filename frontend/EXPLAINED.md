# Project 3 — UI (Frontend): Explanatory Document

**Directory:** `frontend/`
**Language/tooling:** React (plain JavaScript, no TypeScript), Vite,
ethers v6, axios, React Router

---

## 1. What this project is for

The policyholder-facing web application: connect a wallet, view your
claims, file a new claim, and check a specific claim's status. This is
the only piece of the whole system a human directly looks at and clicks
through — every other project (1 and 2) exists to support what happens
when a button here is clicked.

This frontend deliberately talks to only two things directly: the
backend's HTTP API (for everything off-chain), and the user's own wallet
extension plus the `ClaimRegistry` contract directly (for the one
on-chain transaction it submits, `submitClaim`). It never talks to
oracle-service or the indexer — those are backend-to-backend
relationships the UI has no need to know about.

## 2. EIPs used, and why

| EIP | Where | Why |
|---|---|---|
| **EIP-1193** | `useWallet.js`, via `window.ethereum` | The standardized browser-wallet provider interface — this is *why* `window.ethereum.request({ method: 'eth_requestAccounts' })` works the same way regardless of which wallet extension (MetaMask or otherwise) the user has installed. |
| **EIP-191** | `useWallet.js`'s `signMessage`, called from `AuthContext.jsx` | The wallet's `signMessage` call produces a "personal sign" signature — the same format the backend's `eth_account.recover_message` (Project 2) expects and verifies. |

The one on-chain transaction this frontend submits (`submitClaim`) is a
plain contract call, not itself tied to a specific EIP beyond ordinary
EVM transaction semantics.

---

## 3. `frontend/index.html`
**Purpose:** the actual HTML file the browser loads first. Contains a
single `<div id="root">` and a `<script type="module" src="/src/main.jsx">`
— everything visible on the page is rendered into that div by React;
this file itself has almost no content by design (a "single-page
application" shell).

## 4. `frontend/vite.config.js`
**Purpose:** Vite's build/dev-server configuration.
**Imports:** `defineConfig` from `vite`, `react` (the official React
plugin, which is what makes JSX syntax compile and enables React's fast
refresh during development). `server: { port: 5173 }` fixes the dev
server's port explicitly rather than letting Vite pick one, so the rest
of this project's documentation (and the Docker/compose setup) can
reliably say "the frontend runs on 5173."

## 5. `frontend/.env.example`
**Purpose:** the four environment variables Vite exposes to
browser-side code via `import.meta.env` (any variable prefixed
`VITE_` is embedded into the built JavaScript bundle — this is why
these are *not* secrets; anything here is visible to anyone who opens
browser dev tools). `VITE_API_URL` (backend), `VITE_CLAIM_REGISTRY_ADDRESS`
(the deployed contract), `VITE_CHAIN_ID`/`VITE_CHAIN_RPC_URL` (which
network the app expects the wallet to be on).

---

## 6. `frontend/src/main.jsx`
**Purpose:** the actual JavaScript entry point — this is what
`index.html`'s `<script>` tag loads.
**Imports:** `React`, `createRoot` (React 18's rendering API, replacing
the older `ReactDOM.render`), `BrowserRouter` (React Router's
browser-history-based router), the `App` component, and the global
stylesheet.
**What it does:** finds the `#root` div from `index.html` and renders
the whole app into it, wrapped in `React.StrictMode` (a development-only
wrapper that helps catch certain classes of bugs by intentionally
double-invoking some functions) and `BrowserRouter` (which is what makes
`<Link>`/`<Route>` elsewhere in the app work at all).

## 7. `frontend/src/styles.css`
**Purpose:** plain, minimal CSS — no framework. Defines the page's font
and max-width, a reusable `.card` box style, a `.status` badge style, and
an `.error` text-color class. Nothing here is React-specific; it's
loaded once, globally, via `main.jsx`'s import.

---

## 8. `frontend/src/hooks/useWallet.js`
**Purpose:** the one place wallet-connection and message-signing logic
lives, as a custom React hook.

**Imports:** `useCallback, useState` (React's hook APIs), `ethers`.

**`useWallet()`** returns an object with `account`, `error`, `connect`,
`getSigner`, and `signMessage`. Walking through each:
- `connect()` — checks `window.ethereum` exists (no wallet extension
  installed otherwise); calls the EIP-1193 method
  `eth_requestAccounts`, which is what actually triggers the "connect
  your wallet" popup the user sees; stores the first returned account.
  Wrapped in `try/catch` because the user rejecting the connection popup
  throws an error, which this code turns into a readable message instead
  of an unhandled exception.
- `getSigner()` — builds an `ethers.BrowserProvider` wrapping
  `window.ethereum` (this is the ethers v6 way of adapting an
  EIP-1193 provider into ethers' own API) and returns its signer — the
  object capable of actually signing things with the connected account's
  key (which lives in the wallet extension, never in this code).
- `signMessage(message)` — calls the signer's `signMessage`, which is
  what produces an EIP-191 signature; also wrapped in `try/catch` for a
  rejected signature request.

The module-level comment explains a deliberate choice: this hook does
**not** persist connection state to `localStorage` — see `AuthContext.jsx`
below for the full reasoning (it's the same file that actually uses this
hook, so the reasoning is centralized there).

---

## 9. `frontend/src/api/client.js`
**Purpose:** every HTTP call to the backend, in one place.

**Imports:** `axios`.

**`api`** — a pre-configured `axios` instance with the base URL from
`VITE_API_URL`.

**`authHeaders(token)`** — a one-line helper returning
`{ Authorization: 'Bearer ' + token }`, used by every authenticated
call below so the header format is written exactly once.

**`getNonce`, `loginWallet`, `listClaims`, `getClaim`, `createClaim`,
`triggerVerification`** — one function per backend endpoint, each a thin
wrapper around `api.get`/`api.post` with the right path, body, and
headers. `triggerVerification` is the one that also attaches the
`Idempotency-Key` header, taking it as a parameter rather than generating
it internally — because the *caller* (`ClaimStatus.jsx`) needs to control
when a new key is generated versus reused, which this function itself
has no way to know.

---

## 10. `frontend/src/api/contract.js`
**Purpose:** the one piece of this frontend that talks directly to the
blockchain rather than to the backend.

**Imports:** `ethers`.

**`CLAIM_REGISTRY_ABI`** — a minimal, hand-written ABI fragment
containing only the `submitClaim` function signature — the same
"must stay in lockstep with the real contract" pattern used everywhere
else in this project that hand-maintains an ABI (oracle-service,
indexer).

**`submitClaimOnChain(signer, policyId, merkleRoot, amountEther)`** —
constructs an `ethers.Contract` bound to the connected wallet's signer
(meaning any call through it will prompt the wallet to sign and
broadcast a real transaction), converts the human-readable amount into
the token's smallest unit via `ethers.parseEther` (the same conversion
`ClaimRegistry.sol`'s Foundry tests use, just in JavaScript instead of
Solidity), calls `submitClaim`, and awaits one confirmation before
returning the transaction hash. The comment above this function
reiterates a system-wide design point: the frontend never routes this
transaction through the backend — the backend's role is entirely
off-chain metadata and later verification-triggering, never transaction
relaying.

**`placeholderMerkleRoot(claimDescription)`** — hashes the claim
description text alone via `ethers.keccak256(ethers.toUtf8Bytes(...))`.
The lengthy comment is explicit and repeated from elsewhere in this
project: this is a **placeholder**, not a real Merkle tree over actual
evidence documents, because the document-upload pipeline doesn't exist
yet anywhere in this system. It exists only so the rest of the submit
flow (backend record creation, on-chain transaction, indexer
correlation) can be exercised end-to-end using *some* value in the
`merkleRoot` field.

---

## 11. `frontend/src/context/AuthContext.jsx`
**Purpose:** the shared, app-wide state for "is a wallet connected, is
the user logged in, what's their JWT" — implemented as a React Context
so every page can read/use this without prop-drilling it through every
component.

**Imports:** `React, createContext, useContext, useState, useCallback`;
the `useWallet` hook; `getNonce, loginWallet` from the API client.

**`AuthProvider({ children })`** — the component that actually holds the
state and wraps the whole app (see `App.jsx`). Walking through its
internals:
- Calls `useWallet()` once, holding the wallet hook's state.
- `token` (the JWT), `loginError`, `loggingIn` — plain `useState` values.
- `login()` — the full flow: connect the wallet if not already
  connected; call `getNonce` and pull out `message` from the response
  (this is the pre-built message string the backend computed — see
  Project 2's `NonceResponse` schema — the frontend never reconstructs
  this string itself); call `wallet.signMessage(message)`; call
  `loginWallet(address, signature)`; store the returned token. Any
  failure anywhere in this chain sets `loginError` to the most specific
  message available (preferring the backend's own error detail if
  present) and clears any previously-stored token.
- `logout()` — just clears the token from React state (see below for
  why this is enough).

The doc-comment on this whole provider explains the most important
architectural decision in this file: the token is held **only in React
state, never in `localStorage`**. The trade-off stated explicitly: a
page refresh requires logging in again (a real UX cost), accepted
specifically because a token sitting in `localStorage` is readable by
any script that manages to run on the page (an XSS payload), whereas
React state in memory disappears the moment the page is closed or
reloaded and was never written anywhere a script could read outside the
running React app itself.

**`useAuth()`** — the consumer-side hook every page actually calls;
throws a clear error if used outside an `AuthProvider` (a common React
footgun this guards against directly rather than letting it fail with a
confusing `undefined` error later).

---

## 12. `frontend/src/components/WalletConnectButton.jsx`
**Purpose:** the header button — shows "Connect Wallet" or the
connected address, depending on auth state.

**Imports:** `useAuth`.

**What it does:** reads `account, isAuthenticated, login, logout,
loggingIn, loginError, walletError` from the auth context. If already
authenticated, shows a truncated address (`0x1234...abcd` style) and a
"Log out" button. Otherwise shows a "Connect Wallet" button (disabled
and relabeled "Connecting…" while `loggingIn` is true) and displays
either error, if present.

## 13. `frontend/src/components/ClaimStatusBadge.jsx`
**Purpose:** a tiny, purely presentational component mapping the raw
backend status string (`"under_review"`) to a human-readable label
("Under Review"). `STATUS_LABELS` is a plain lookup object; if a status
somehow isn't in the map, it falls back to displaying the raw string
rather than crashing or showing nothing.

---

## 14. `frontend/src/App.jsx`
**Purpose:** the root component — routing and the overall page shell.

**Imports:** `Routes, Route, Link` from `react-router-dom`;
`AuthProvider, useAuth`; the three page components; `WalletConnectButton`.

**`RequireAuth({ children })`** — a small wrapper component: if
`isAuthenticated` is false, renders a "connect your wallet" message
instead of `children`; otherwise renders `children` normally. Used to
guard all three real pages — none of them are reachable without being
logged in.

**`Shell()`** — the actual header/nav/routing layout: a header with the
title, navigation links, and the wallet button, then a `<Routes>` block
mapping the three paths (`/`, `/file-claim`, `/claim-status`) to their
page components, each wrapped in `RequireAuth`.

**`App()`** — the true top-level export: wraps `Shell` in `AuthProvider`,
which is what makes `useAuth()` work anywhere inside `Shell` and its
children.

---

## 15. `frontend/src/pages/Dashboard.jsx`
**Purpose:** lists the logged-in user's own claims.

**Imports:** `useEffect, useState`; `Link`; `useAuth`; `listClaims`;
`ClaimStatusBadge`.

**What it does:** on mount (and whenever `token` changes), calls
`listClaims(token)`. Uses a `cancelled` flag inside the effect's cleanup
function — a standard React pattern preventing a slow request's response
from being applied to state after the component has already unmounted
(which would otherwise log a React warning and could show stale data).
Renders a loading state, an error state, an empty state (with a link to
file the first claim), or the actual list — each claim shows its ID,
policy, amount, and status badge, plus either the on-chain claim ID and
truncated transaction hash (if the indexer has synced it already) or a
grey "not yet confirmed on-chain" note explaining the expected delay.

## 16. `frontend/src/pages/FileClaim.jsx`
**Purpose:** the full claim-submission flow — the most involved page in
this project, because it's the one that spans both the backend and the
blockchain in a single user action.

**Imports:** `useState`; `useNavigate`; `useAuth`; `createClaim`;
`submitClaimOnChain, placeholderMerkleRoot`.

**`handleSubmit(e)`** — walking through it:
1. `e.preventDefault()` — stops the browser's default full-page-reload
   form submission behavior.
2. Validates `policyId` and `amount` are both present.
3. Computes `merkleRoot` via the placeholder function, **once**, before
   either the backend call or the on-chain call — so both calls use the
   exact same value, which is what lets the indexer later correlate them.
4. Sets `step` to `'creating'` (drives the button's changing label) and
   calls `createClaim` — the off-chain record.
5. Sets `step` to `'submitting-onchain'`, dynamically imports `ethers`
   (a lazy import — avoids pulling the whole ethers library into the
   initial page bundle for a page that might not always need it
   immediately), builds a `BrowserProvider`/signer from the connected
   wallet, and calls `submitClaimOnChain`.
6. On success, sets `step` to `'done'` and stores the claim ID + tx hash
   for display. On any failure at any step, resets to `'idle'` and shows
   the most specific error message available.

The page also renders an explicit, visible note above the form that
evidence upload isn't wired up yet — the UI itself tells the user this,
rather than silently pretending the placeholder hash is real evidence.

## 17. `frontend/src/pages/ClaimStatus.jsx`
**Purpose:** look up a specific claim by ID and, if it's in `submitted`
status, trigger oracle verification.

**Imports:** `useState`; `useAuth`; `getClaim, triggerVerification`;
`ClaimStatusBadge`.

**`handleSearch()`** — calls `getClaim`, and — this is a specific,
deliberate detail — generates a **fresh** `crypto.randomUUID()` for
`idempotencyKey` only here, once per successful lookup, not inside
`handleTriggerVerification`. The comment explains why: if the key were
generated fresh on every button click, a user re-clicking "Trigger
Verification" while a request is still in flight (or retrying after a
network blip) would send a *different* key each time, completely
defeating the backend's idempotency protection, which only works if
retries reuse the same key.

**`handleTriggerVerification()`** — calls `triggerVerification` with the
claim's ID and the stored key, then re-fetches the claim to show the
updated status immediately rather than waiting for the user to search
again.

---

## 18. `frontend/test/contract.test.js`
**Purpose:** the one test file in this project — pure unit tests (no
DOM, no network) for `placeholderMerkleRoot`: the same input produces
the same hash deterministically; different inputs produce different
hashes; and an empty or `undefined` description falls back to the same
fixed placeholder string, producing identical output either way.

---

## 19. Execution steps for this project specifically

1. `cd frontend && npm install`
2. `cp .env.example .env` — fill in `VITE_CLAIM_REGISTRY_ADDRESS` (from
   Project 1's deployment) and `VITE_CHAIN_ID`/`VITE_CHAIN_RPC_URL` to
   match whichever network is actually running.
3. `npm test` — runs the one existing unit test.
4. Add the same network to MetaMask (or your wallet of choice): RPC URL
   matching `VITE_CHAIN_RPC_URL`, chain ID matching `VITE_CHAIN_ID`.
5. Import a funded account into that wallet (an Anvil default account,
   or a funded Besu-network account).
6. `npm run dev` and open the printed local URL (`http://localhost:5173`
   by default).
7. Confirm the backend (Project 2, Part A) is running and reachable at
   `VITE_API_URL` — this frontend has nothing to talk to otherwise.

## 20. Next actions specific to this project

- Replace `placeholderMerkleRoot` with a real evidence pipeline: file
  upload UI, client-side (or backend) SHA-256 hashing per file, and an
  actual Merkle tree over the resulting hashes — this is the single
  biggest gap in this project, and it's a gap shared with Project 2's
  backend (whose `ClaimDocument` schema already expects the real shape,
  just has nothing populating it yet).
- Add live-updating claim status (polling, or a WebSocket/SSE push from
  the backend) — currently Dashboard/ClaimStatus only reflect whatever
  was true at the last manual page load or search.
- Build an underwriter/reviewer view — this frontend only ever covers
  the policyholder role; approving or rejecting a claim currently has no
  UI anywhere in this system.
- Add component and end-to-end tests — currently only one pure-function
  unit test exists; a Playwright test against a real running backend and
  deployed contract (the same category of test built for Projects 1 and
  2) is the natural next layer, and was explicitly deferred rather than
  built in this pass.
- Reconsider the no-`localStorage` trade-off if repeated re-login on
  every refresh proves too costly in practice — the reasoning for the
  current choice is documented in `AuthContext.jsx`, and revisiting it
  is a legitimate option, not a mistake to silently reverse.
