# Smart Contract & Test Architecture Diagrams — Explained

This document collects the nine reference diagrams built for the
DICS v2 smart-contract layer and its test suite, each followed by a
consistent five-part explanation: what the diagram is for, why it
needed to exist at all, what it actually shows, what it's built from,
and — the part most explanations skip — what specifically goes wrong
in practice if a developer doesn't have this picture in their head.

**How to read the colors across this whole document:** color always
groups things into a *category* (a shared base class, an entity, a
governance mechanism) — it is never a severity scale, except in
diagrams 6 and 9, where red specifically marks a revert/failure
outcome and is called out as such at that point.

---

## 1. Contract inheritance, grouped by shared base classes

<svg width="100%" viewBox="0 0 680 460" role="img" xmlns="http://www.w3.org/2000/svg">
<title>Contract inheritance grouped by shared base classes</title>
<defs>
<marker id="a1" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M2 1L8 5L2 9" fill="none" stroke="#5f5e5a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</marker>
</defs>
<rect x="30" y="20" width="620" height="150" rx="12" fill="none" stroke="#888780" stroke-width="1" stroke-dasharray="4 3"/>
<text x="50" y="38" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">Common base set</text>
<rect x="50" y="52" width="180" height="44" rx="8" fill="#E6F1FB" stroke="#185FA5" stroke-width="1"/>
<text x="140" y="79" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#0C447C">Initializable</text>
<rect x="250" y="52" width="180" height="44" rx="8" fill="#E6F1FB" stroke="#185FA5" stroke-width="1"/>
<text x="340" y="79" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="13" font-weight="600" fill="#0C447C">AccessControlUpgradeable</text>
<rect x="450" y="52" width="180" height="44" rx="8" fill="#E6F1FB" stroke="#185FA5" stroke-width="1"/>
<text x="540" y="79" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="13" font-weight="600" fill="#0C447C">PausableUpgradeable</text>
<rect x="150" y="116" width="180" height="44" rx="8" fill="#E6F1FB" stroke="#185FA5" stroke-width="1"/>
<text x="240" y="143" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#0C447C">ReentrancyGuard</text>
<rect x="350" y="116" width="180" height="44" rx="8" fill="#E6F1FB" stroke="#185FA5" stroke-width="1"/>
<text x="440" y="143" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#0C447C">UUPSUpgradeable</text>
<line x1="340" y1="170" x2="340" y2="208" stroke="#5f5e5a" stroke-width="1.5" marker-end="url(#a1)"/>
<rect x="180" y="210" width="320" height="56" rx="8" fill="#E1F5EE" stroke="#0F6E56" stroke-width="1"/>
<text x="340" y="230" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#085041">Used by 3 contracts</text>
<text x="340" y="248" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#0F6E56">ClaimRegistry, InsurancePolicy, Vault</text>
<text x="40" y="304" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#2c2c2a">Remaining contracts, each a distinct set</text>
<line x1="40" y1="314" x2="640" y2="314" stroke="#d3d1c7" stroke-width="1"/>
<text x="40" y="336" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#2c2c2a">OracleAdapter</text>
<text x="220" y="336" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">Initializable, AccessControl, Pausable, UUPS, EIP712</text>
<text x="40" y="356" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#2c2c2a">PriceOracle</text>
<text x="220" y="356" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">Initializable, AccessControl, UUPS</text>
<text x="40" y="376" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#2c2c2a">StableCoin</text>
<text x="220" y="376" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">plain ERC20, not upgradeable</text>
<text x="40" y="396" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#2c2c2a">DICSGovernanceToken</text>
<text x="220" y="396" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">ERC20, ERC20Permit, ERC20Votes</text>
<text x="40" y="416" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#2c2c2a">DICSGovernor</text>
<text x="220" y="416" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">Governor plus five Governor extensions</text>
<text x="40" y="436" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#2c2c2a">ClaimGasPaymaster</text>
<text x="220" y="436" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">BasePaymaster (EIP-4337)</text>
</svg>

**Purpose.** Shows which OpenZeppelin (and account-abstraction) base
contracts each of the 9 project contracts is actually built from.

**Why this diagram needed to exist.** Solidity resolves multiple
inheritance through explicit `override(...)` lists, and getting that
list wrong doesn't fail quietly — it either won't compile at all, or
compiles but silently resolves to the wrong parent implementation.
This project hit that exact problem more than once while building
`DICSGovernor.sol`, where the correct override target genuinely
differed between functions and even shifted between two supposedly
identical dependency installs. A diagram that makes the shared base
set visible at a glance is what turns "why won't this compile" into
"oh, that's why."

**What it explains.** Three of the nine contracts — `ClaimRegistry`,
`InsurancePolicy`, and `Vault` — share the exact same five-contract
foundation. The other six each diverge in a specific, deliberate way:
`OracleAdapter` swaps `ReentrancyGuard` for `EIP712Upgradeable`;
`PriceOracle` drops both `Pausable` and `ReentrancyGuard` entirely;
`StableCoin` isn't upgradeable at all; and the governance/token/
paymaster contracts each sit in a completely different inheritance
family.

**What it consists of.** A dashed container grouping the five shared
base contracts, one summary box naming the three contracts that use
all five together, and a compact reference list for the remaining six
contracts' own distinct base sets.

**What goes wrong without it.** A developer copy-pasting an inheritance
list from one contract to another — a very natural shortcut — could
add `ReentrancyGuardUpgradeable` (which does not exist at all in
OpenZeppelin v5, a real bug this project hit directly), drop
`UUPSUpgradeable` by accident (silently making the contract
non-upgradeable forever, since that mistake only surfaces the day
someone actually tries to upgrade it), or misjudge which functions
need an `override` list in the first place.

---

## 2. `InsurancePolicy.sol` storage layout

<svg width="100%" viewBox="0 0 680 560" role="img" xmlns="http://www.w3.org/2000/svg">
<title>InsurancePolicy.sol storage layout</title>
<defs>
<marker id="a2" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M2 1L8 5L2 9" fill="none" stroke="#5f5e5a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</marker>
</defs>
<rect x="60" y="40" width="560" height="70" rx="12" fill="none" stroke="#888780" stroke-width="1" stroke-dasharray="4 3"/>
<text x="80" y="64" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#2c2c2a">Inherited base contracts</text>
<text x="80" y="84" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">AccessControlUpgradeable, PausableUpgradeable, Initializable</text>
<text x="80" y="100" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">each keep their own storage at a separate ERC-7201 hashed location</text>
<rect x="60" y="140" width="560" height="380" rx="12" fill="#E1F5EE" stroke="#0F6E56" stroke-width="1"/>
<text x="80" y="164" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#085041">InsurancePolicy&#8217;s own sequential storage</text>
<g>
<rect x="90" y="182" width="500" height="30" rx="6" fill="#EEEDFE" stroke="#534AB7" stroke-width="1"/>
<text x="106" y="201" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#3C3489">Slot 0</text>
<text x="580" y="201" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#534AB7">_policies mapping</text>
</g>
<g>
<rect x="90" y="216" width="500" height="30" rx="6" fill="#EEEDFE" stroke="#534AB7" stroke-width="1"/>
<text x="106" y="235" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#3C3489">Slot 1</text>
<text x="580" y="235" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#534AB7">_exists mapping</text>
</g>
<g>
<rect x="90" y="250" width="500" height="30" rx="6" fill="#EEEDFE" stroke="#534AB7" stroke-width="1"/>
<text x="106" y="269" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#3C3489">Slot 2</text>
<text x="580" y="269" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#534AB7">premiumToken</text>
</g>
<g>
<rect x="90" y="284" width="500" height="30" rx="6" fill="#EEEDFE" stroke="#534AB7" stroke-width="1"/>
<text x="106" y="303" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#3C3489">Slot 3</text>
<text x="580" y="303" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#534AB7">premiumTreasury</text>
</g>
<g>
<rect x="90" y="318" width="500" height="30" rx="6" fill="#EEEDFE" stroke="#534AB7" stroke-width="1"/>
<text x="106" y="337" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#3C3489">Slot 4</text>
<text x="580" y="337" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#534AB7">premiumGracePeriodSeconds</text>
</g>
<g>
<rect x="90" y="352" width="500" height="30" rx="6" fill="#EEEDFE" stroke="#534AB7" stroke-width="1"/>
<text x="106" y="371" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#3C3489">Slot 5</text>
<text x="580" y="371" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#534AB7">premiumTerms mapping</text>
</g>
<g>
<rect x="90" y="386" width="500" height="30" rx="6" fill="#EEEDFE" stroke="#534AB7" stroke-width="1"/>
<text x="106" y="405" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#3C3489">Slot 6</text>
<text x="580" y="405" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#534AB7">premiumPaidUntil mapping</text>
</g>
<g>
<rect x="90" y="420" width="500" height="30" rx="6" fill="#FAECE7" stroke="#993C1D" stroke-width="1"/>
<text x="106" y="439" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#712B13">Slot 7</text>
<text x="580" y="439" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#993C1D">policyTemplates mapping</text>
</g>
<g>
<rect x="90" y="454" width="500" height="30" rx="6" fill="#FAECE7" stroke="#993C1D" stroke-width="1"/>
<text x="106" y="473" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#712B13">Slot 8</text>
<text x="580" y="473" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#993C1D">nextPolicyId</text>
</g>
<g>
<rect x="90" y="488" width="500" height="30" rx="6" fill="#F1EFE8" stroke="#888780" stroke-width="1" stroke-dasharray="3 2"/>
<text x="106" y="507" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#444441">Slots 9&#8211;48</text>
<text x="580" y="507" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">__gap[40] reserved</text>
</g>
</svg>

**Purpose.** Shows exactly which storage slot each of
`InsurancePolicy.sol`'s own declared variables occupies, in the exact
order they were declared, and where the reserved buffer for future
additions sits.

**Why this diagram needed to exist.** Upgradeable contracts are
uniquely fragile around storage in a way most developers coming from
ordinary Solidity, or from any Web2 backend, have never had to think
about: two deployments of the *same logical contract* — the old
version and the new one — must agree on what every storage slot
*means*, because the proxy's storage physically persists across the
upgrade untouched. OpenZeppelin v5 makes this subtler still by moving
each *inherited* contract's own storage into a separately hashed
location (ERC-7201), which is exactly the distinction this diagram
draws between the dashed "inherited" box and the solid "own storage"
box below it.

**What it explains.** Slots 0–1 predate the premium module; slots 2–6
were added when premium billing was built; slots 7–8 were added later
still, when the self-service policy catalog was built — each addition
correctly *appended* rather than inserted, and each addition correctly
shrank the reserved `__gap` by exactly the number of new slots it
consumed (47 → 42 → 40, as documented in the contract's own history).

**What it consists of.** A dashed note explaining that base-contract
storage lives elsewhere entirely, a solid container for the contract's
own sequential slots, one row per declared variable color-grouped by
which feature introduced it, and a final reserved block.

**What goes wrong without it.** If a future change inserted a new
variable in the *middle* of this list instead of appending it before
the gap, every variable declared after it would silently shift to a
different slot number the moment the upgrade went live — meaning the
new implementation code would read and write the *wrong* variable's
data for every single existing policy, with no error, no revert, and
no warning. This is the single most catastrophic and hardest-to-detect
class of bug in upgradeable contracts, and the entire reason `__gap`
and "always append, never insert" exist as a discipline in the first
place.

---

## 3. `ClaimRegistry.submitClaim` call graph

<svg width="100%" viewBox="0 0 680 320" role="img" xmlns="http://www.w3.org/2000/svg">
<title>Internal call graph for ClaimRegistry.submitClaim</title>
<defs>
<marker id="a3" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M2 1L8 5L2 9" fill="none" stroke="#5f5e5a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</marker>
</defs>
<rect x="250" y="40" width="180" height="44" rx="8" fill="#F1EFE8" stroke="#5F5E5A" stroke-width="1"/>
<text x="340" y="67" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#2c2c2a">submitClaim</text>
<rect x="60" y="150" width="170" height="56" rx="8" fill="#E6F1FB" stroke="#185FA5" stroke-width="1"/>
<text x="145" y="173" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#0C447C">getPolicy</text>
<text x="145" y="191" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#185FA5">external, InsurancePolicy</text>
<rect x="255" y="150" width="170" height="56" rx="8" fill="#E6F1FB" stroke="#185FA5" stroke-width="1"/>
<text x="340" y="173" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="13" font-weight="600" fill="#0C447C">isPremiumCurrent</text>
<text x="340" y="191" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#185FA5">external, InsurancePolicy</text>
<rect x="450" y="150" width="170" height="56" rx="8" fill="#F1EFE8" stroke="#5F5E5A" stroke-width="1"/>
<text x="535" y="173" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="13" font-weight="600" fill="#2c2c2a">_consumedCoverage</text>
<text x="535" y="191" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">internal, same contract</text>
<rect x="250" y="250" width="180" height="44" rx="8" fill="#E1F5EE" stroke="#0F6E56" stroke-width="1"/>
<text x="340" y="277" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#085041">writes Claim record</text>
<path d="M300 84 L145 84 L145 148" fill="none" stroke="#5f5e5a" stroke-width="1.5" marker-end="url(#a3)"/>
<line x1="340" y1="84" x2="340" y2="148" stroke="#5f5e5a" stroke-width="1.5" marker-end="url(#a3)"/>
<path d="M380 84 L535 84 L535 148" fill="none" stroke="#5f5e5a" stroke-width="1.5" marker-end="url(#a3)"/>
<path d="M145 206 L145 228 L340 228 L340 248" fill="none" stroke="#5f5e5a" stroke-width="1.5" marker-end="url(#a3)"/>
<line x1="340" y1="206" x2="340" y2="248" stroke="#5f5e5a" stroke-width="1.5" marker-end="url(#a3)"/>
<path d="M535 206 L535 228 L340 228" fill="none" stroke="#5f5e5a" stroke-width="1.5"/>
</svg>

**Purpose.** Shows exactly what `submitClaim` calls internally, and —
critically — distinguishes calls that stay inside `ClaimRegistry` from
calls that cross into a different deployed contract.

**Why this diagram needed to exist.** Reading a function's source code
top to bottom doesn't make this distinction visually obvious:
`getPolicy(...)` and `_consumedCoverage(...)` look almost identical as
lines of code, but one of them leaves this contract's own execution
context entirely and the other never does. That difference has real
consequences — an external call can fail for reasons entirely outside
this contract's control (the target is paused, the target was
upgraded, the target simply reverts), while an internal call cannot.

**What it explains.** `submitClaim` makes exactly two external,
read-only calls into `InsurancePolicy` (`getPolicy`, `isPremiumCurrent`)
and one internal call within `ClaimRegistry` itself
(`_consumedCoverage`), before it ever writes anything to storage.

**What it consists of.** One entry node, three called-function nodes
each explicitly labeled internal or external and naming which contract
they belong to, and a final node representing the actual state write
that only happens after every check above it has passed.

**What goes wrong without it.** A developer who doesn't internalize
that two of these three calls are external might not realize that
pausing or upgrading `InsurancePolicy` changes what `submitClaim` does
on `ClaimRegistry` — a cross-contract dependency that's easy to miss if
you only ever read `ClaimRegistry.sol` in isolation. It also matters
for ordering: external calls are exactly the kind of operation that
belongs *after* internal state checks, not before — the classic
checks-effects-interactions pattern this diagram makes visually
concrete rather than abstract.

---

## 4. Policy, premium, and claim entity relationships

<svg width="100%" viewBox="0 0 680 380" role="img" xmlns="http://www.w3.org/2000/svg">
<title>Entity relationship diagram for PolicyTemplate, Policy, PremiumTerms and Claim</title>
<defs>
<marker id="a4" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M2 1L8 5L2 9" fill="none" stroke="#5f5e5a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</marker>
</defs>
<rect x="40" y="40" width="270" height="128" rx="8" fill="#EEEDFE" stroke="#534AB7" stroke-width="1"/>
<line x1="40" y1="72" x2="310" y2="72" stroke="#534AB7" stroke-width="1" opacity="0.4"/>
<text x="56" y="60" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#3C3489">POLICY_TEMPLATE</text>
<text x="56" y="90" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#534AB7">templateId (PK)</text>
<text x="56" y="108" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#534AB7">coverageAmount, premiumAmountPerPeriod</text>
<text x="56" y="126" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#534AB7">periodSeconds, termSeconds</text>
<text x="56" y="144" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#534AB7">active</text>
<rect x="370" y="40" width="270" height="128" rx="8" fill="#EEEDFE" stroke="#534AB7" stroke-width="1"/>
<line x1="370" y1="72" x2="640" y2="72" stroke="#534AB7" stroke-width="1" opacity="0.4"/>
<text x="386" y="60" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#3C3489">POLICY</text>
<text x="386" y="90" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#534AB7">policyId (PK)</text>
<text x="386" y="108" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#534AB7">coverageAmount, holder</text>
<text x="386" y="126" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#534AB7">validFrom, validUntil</text>
<text x="386" y="144" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#534AB7">revoked</text>
<rect x="370" y="220" width="270" height="96" rx="8" fill="#FAECE7" stroke="#993C1D" stroke-width="1"/>
<line x1="370" y1="252" x2="640" y2="252" stroke="#993C1D" stroke-width="1" opacity="0.4"/>
<text x="386" y="240" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#712B13">PREMIUM_TERMS</text>
<text x="386" y="270" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#993C1D">policyId (PK, FK)</text>
<text x="386" y="288" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#993C1D">amountPerPeriod, periodSeconds</text>
<rect x="40" y="220" width="270" height="128" rx="8" fill="#E1F5EE" stroke="#0F6E56" stroke-width="1"/>
<line x1="40" y1="252" x2="310" y2="252" stroke="#0F6E56" stroke-width="1" opacity="0.4"/>
<text x="56" y="240" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#085041">CLAIM</text>
<text x="56" y="270" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#0F6E56">claimId (PK)</text>
<text x="56" y="288" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#0F6E56">policyId (FK), claimant</text>
<text x="56" y="306" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#0F6E56">amount</text>
<text x="56" y="324" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#0F6E56">status</text>
<line x1="310" y1="56" x2="366" y2="56" stroke="#5f5e5a" stroke-width="1.5" marker-end="url(#a4)"/>
<text x="315" y="48" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">instantiated as</text>
<line x1="505" y1="168" x2="505" y2="216" stroke="#5f5e5a" stroke-width="1.5" marker-end="url(#a4)"/>
<text x="515" y="196" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">billed via</text>
<path d="M175 168 L175 190 L175 216" fill="none" stroke="#5f5e5a" stroke-width="1.5" marker-end="url(#a4)"/>
<text x="185" y="185" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">claimed against</text>
</svg>

**Purpose.** Shows the on-chain data model on its own — which records
exist and how they reference each other — independent of any single
function that happens to touch them.

**Why this diagram needed to exist.** Without seeing the data model in
one place, a developer tends to reconstruct it piecemeal from whatever
function they're currently reading, and that reconstruction is easy to
get subtly wrong — especially around cardinality (is this a one-to-one
or one-to-many relationship?), which no amount of reading
`submitClaim`'s code alone will make obvious.

**What it explains.** A `PolicyTemplate` is a catalog entry that gets
copied into a brand-new `Policy` record at subscription time (not
referenced by pointer — copied); every `Policy` has exactly one
`PremiumTerms` record; and every `Policy` can have *many* `Claim`
records over its lifetime, not just one.

**What it consists of.** Four entity boxes, each listing its primary
and foreign keys plus its other fields, connected by labeled
relationship arrows.

**What goes wrong without it.** The most likely real mistake is
assuming a policy can only ever have one active claim — which would
lead to a bug (or an incorrect test) where filing a second, entirely
legitimate claim against a policy that already has one seems like it
should fail, when the actual system is explicitly designed to allow
multiple claims against the same policy as long as their combined
total stays within coverage. A second common mistake: trying to read
premium information directly off the `Policy` struct, not realizing
it's deliberately a separate record.

---

## 5. Deployment and ownership — who controls what

<svg width="100%" viewBox="0 0 680 400" role="img" xmlns="http://www.w3.org/2000/svg">
<title>Deployment and ownership diagram for the claims domain</title>
<defs>
<marker id="a5" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M2 1L8 5L2 9" fill="none" stroke="#5f5e5a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</marker>
</defs>
<rect x="70" y="40" width="230" height="56" rx="8" fill="#EEEDFE" stroke="#534AB7" stroke-width="1"/>
<text x="185" y="63" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#3C3489">Claims Timelock</text>
<text x="185" y="81" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#534AB7">ADMIN_ROLE, UPGRADER_ROLE</text>
<rect x="380" y="40" width="230" height="56" rx="8" fill="#EEEDFE" stroke="#534AB7" stroke-width="1"/>
<text x="495" y="63" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#3C3489">Underwriter Safe</text>
<text x="495" y="81" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#534AB7">UNDERWRITER_ROLE only</text>
<rect x="70" y="180" width="230" height="56" rx="8" fill="#E6F1FB" stroke="#185FA5" stroke-width="1"/>
<text x="185" y="203" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#0C447C">InsurancePolicy proxy</text>
<text x="185" y="221" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#185FA5">ERC1967Proxy</text>
<rect x="380" y="180" width="230" height="56" rx="8" fill="#E6F1FB" stroke="#185FA5" stroke-width="1"/>
<text x="495" y="203" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#0C447C">ClaimRegistry proxy</text>
<text x="495" y="221" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#185FA5">ERC1967Proxy</text>
<rect x="70" y="300" width="230" height="44" rx="8" fill="#F1EFE8" stroke="#888780" stroke-width="1" stroke-dasharray="3 2"/>
<text x="185" y="327" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#444441">Implementation</text>
<rect x="380" y="300" width="230" height="44" rx="8" fill="#F1EFE8" stroke="#888780" stroke-width="1" stroke-dasharray="3 2"/>
<text x="495" y="327" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#444441">Implementation</text>
<path d="M185 96 L185 178" fill="none" stroke="#5f5e5a" stroke-width="1.5" stroke-dasharray="3 2" marker-end="url(#a5)"/>
<path d="M300 68 L340 68 L340 208 L378 208" fill="none" stroke="#5f5e5a" stroke-width="1.5" stroke-dasharray="3 2" marker-end="url(#a5)"/>
<line x1="495" y1="96" x2="495" y2="178" stroke="#5f5e5a" stroke-width="1.5" marker-end="url(#a5)"/>
<line x1="185" y1="236" x2="185" y2="298" stroke="#5f5e5a" stroke-width="1.5" stroke-dasharray="3 2" marker-end="url(#a5)"/>
<line x1="495" y1="236" x2="495" y2="298" stroke="#5f5e5a" stroke-width="1.5" stroke-dasharray="3 2" marker-end="url(#a5)"/>
<text x="510" y="140" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">role-gated calls</text>
</svg>

**Purpose.** Shows who actually controls what in the deployed system,
distinguishing *upgrade authority* (the power to change a contract's
logic entirely) from *operational role authority* (the power to call
specific already-existing functions).

**Why this diagram needed to exist.** This project has two genuinely
separate governance mechanisms now: a Timelock that can upgrade both
proxies, and a Safe multisig that can approve or reject claims but has
no upgrade power at all. Conflating "who can approve a claim" with
"who can rewrite the contract's entire logic" is exactly the kind of
mistake that turns a routine access-control decision into a real
security incident.

**What it explains.** The Claims Timelock reaches both proxies with
*dashed* upgrade-authority arrows and touches neither contract's actual
business logic directly; the Underwriter Safe reaches only
`ClaimRegistry`, with a *solid* arrow representing real, immediate
function calls (`setClaimStatus`, `payoutClaim`); and each proxy
delegates its logic to its own separate implementation contract.

**What it consists of.** Two governance boxes at the top, two proxy
boxes in the middle, two implementation boxes at the bottom, dashed
lines for upgrade authority, and one solid line for the role-gated
operational call path.

**What goes wrong without it.** Someone provisioning access — granting
a role, adding a new Safe owner — could reasonably but wrongly assume
that adding themselves as a Safe owner also gives them any upgrade
power, or that Timelock membership implies the ability to approve
claims. Neither is true, and this diagram is what makes that
structurally obvious rather than something you have to already know.

---

## 6. Test coverage matrix

<svg width="100%" viewBox="0 0 680 380" role="img" xmlns="http://www.w3.org/2000/svg">
<title>Test coverage matrix across the 7 Foundry test files</title>
<text x="40" y="30" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#2c2c2a">File</text>
<text x="270" y="30" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#2c2c2a">Happy path</text>
<text x="380" y="30" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#2c2c2a">Access control</text>
<text x="490" y="30" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#2c2c2a">Edge cases</text>
<text x="600" y="30" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#2c2c2a">Upgrade safety</text>
<line x1="40" y1="42" x2="640" y2="42" stroke="#d3d1c7" stroke-width="1"/>
<text x="40" y="74" font-family="Helvetica,Arial,sans-serif" font-size="13" fill="#2c2c2a">InsurancePolicy.t.sol</text>
<circle cx="270" cy="70" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="380" cy="70" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="490" cy="70" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="600" cy="70" r="7" fill="none" stroke="#B4B2A9" stroke-width="1"/>
<text x="40" y="110" font-family="Helvetica,Arial,sans-serif" font-size="13" fill="#2c2c2a">OracleAdapter.t.sol</text>
<circle cx="270" cy="106" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="380" cy="106" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="490" cy="106" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="600" cy="106" r="7" fill="none" stroke="#B4B2A9" stroke-width="1"/>
<text x="40" y="146" font-family="Helvetica,Arial,sans-serif" font-size="13" fill="#2c2c2a">ClaimRegistryUpgrade.t.sol</text>
<circle cx="270" cy="142" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="380" cy="142" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="490" cy="142" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="600" cy="142" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<text x="40" y="182" font-family="Helvetica,Arial,sans-serif" font-size="13" fill="#2c2c2a">Premium.t.sol</text>
<circle cx="270" cy="178" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="380" cy="178" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="490" cy="178" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="600" cy="178" r="7" fill="none" stroke="#B4B2A9" stroke-width="1"/>
<text x="40" y="218" font-family="Helvetica,Arial,sans-serif" font-size="13" fill="#2c2c2a">PolicyCatalog.t.sol</text>
<circle cx="270" cy="214" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="380" cy="214" r="7" fill="none" stroke="#B4B2A9" stroke-width="1"/>
<circle cx="490" cy="214" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="600" cy="214" r="7" fill="none" stroke="#B4B2A9" stroke-width="1"/>
<text x="40" y="254" font-family="Helvetica,Arial,sans-serif" font-size="13" fill="#2c2c2a">Vault.t.sol</text>
<circle cx="270" cy="250" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="380" cy="250" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="490" cy="250" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="600" cy="250" r="7" fill="none" stroke="#B4B2A9" stroke-width="1"/>
<text x="40" y="290" font-family="Helvetica,Arial,sans-serif" font-size="13" fill="#2c2c2a">Governance.t.sol</text>
<circle cx="270" cy="286" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="380" cy="286" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="490" cy="286" r="7" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<circle cx="600" cy="286" r="7" fill="none" stroke="#B4B2A9" stroke-width="1"/>
<circle cx="230" cy="330" r="6" fill="#1D9E75" stroke="#0F6E56" stroke-width="1"/>
<text x="244" y="334" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">covered</text>
<circle cx="340" cy="330" r="6" fill="none" stroke="#B4B2A9" stroke-width="1"/>
<text x="354" y="334" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">not covered / not applicable</text>
</svg>

**Purpose.** Gives an at-a-glance view of which *categories* of
behavior are actually tested in each of the 7 Foundry test files,
rather than just a pass/fail count.

**Why this diagram needed to exist.** Test suites grow file by file,
function by function, over the life of a project. Without a
consolidated view like this, it's genuinely easy for a team to believe
"we have good test coverage" purely because the total test count is
high, without anyone having actually checked whether the tests that
exist cover the categories that matter — access control and upgrade
safety being the two categories where a gap is most expensive.

**What it explains.** Every file covers its own happy path. Most cover
access control and edge cases too. But only one file in the entire
suite — `ClaimRegistryUpgrade.t.sol` — actually exercises upgrade
safety at all, and `PolicyCatalog.t.sol`'s "no" on access control is
correct as designed: `subscribeToPolicy` is deliberately open to
anyone, so there's no access restriction to test there in the first
place.

**What it consists of.** A 7-row by 4-column grid, filled dots meaning
"covered," outlined dots meaning "not covered or not applicable," row
labels naming each test file, and column headers naming each category.

**What goes wrong without it.** A team could ship a real change to,
say, `Vault.sol`'s upgrade path with full confidence because "all
tests pass," without ever noticing that upgrade safety is tested for
exactly one contract in this entire project — a gap invisible from
reading any single test file, and only visible once every file's
coverage is placed side by side like this.

---

## 7. Mock versus real dependencies — the same choice, made two different ways

<svg width="100%" viewBox="0 0 680 280" role="img" xmlns="http://www.w3.org/2000/svg">
<title>Mock versus real contract dependencies in two test files</title>
<defs>
<marker id="a7" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M2 1L8 5L2 9" fill="none" stroke="#5f5e5a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</marker>
</defs>
<rect x="30" y="40" width="290" height="200" rx="12" fill="none" stroke="#888780" stroke-width="1"/>
<text x="50" y="66" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#2c2c2a">ClaimRegistryUpgrade.t.sol</text>
<text x="50" y="84" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">isolates ClaimRegistry&#8217;s own logic</text>
<rect x="55" y="110" width="240" height="48" rx="8" fill="#E1F5EE" stroke="#0F6E56" stroke-width="1"/>
<text x="175" y="130" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#085041">ClaimRegistry</text>
<text x="175" y="148" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#0F6E56">real contract</text>
<rect x="55" y="170" width="240" height="48" rx="8" fill="#FAECE7" stroke="#993C1D" stroke-width="1"/>
<text x="175" y="190" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#712B13">MockPolicyRegistry</text>
<text x="175" y="208" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#993C1D">mocked, settable state</text>
<rect x="360" y="40" width="290" height="200" rx="12" fill="none" stroke="#888780" stroke-width="1"/>
<text x="380" y="66" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#2c2c2a">Premium.t.sol</text>
<text x="380" y="84" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">proves the real pair together</text>
<rect x="385" y="110" width="240" height="48" rx="8" fill="#E1F5EE" stroke="#0F6E56" stroke-width="1"/>
<text x="505" y="130" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#085041">InsurancePolicy</text>
<text x="505" y="148" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#0F6E56">real contract</text>
<rect x="385" y="170" width="240" height="48" rx="8" fill="#E1F5EE" stroke="#0F6E56" stroke-width="1"/>
<text x="505" y="190" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#085041">ClaimRegistry</text>
<text x="505" y="208" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#0F6E56">real contract</text>
</svg>

**Purpose.** Shows, for two specific test files, whether each
contract they depend on is the real thing or a hand-built mock — and
makes the point that this project made that choice *differently* for
each file, on purpose.

**Why this diagram needed to exist.** Developers new to testing often
treat "mock it" and "use the real thing" as a single global policy —
either you mock everything for speed and isolation, or you use real
dependencies for maximum confidence. Neither instinct is right on its
own; the correct choice depends entirely on what a given test is
actually trying to prove.

**What it explains.** `ClaimRegistryUpgrade.t.sol` mocks
`InsurancePolicy` specifically so it can test `ClaimRegistry`'s own
logic — rate limiting, upgrade safety, coverage math — without that
logic being entangled with a second contract's behavior.
`Premium.t.sol` does the opposite on purpose: it uses the real pair
together specifically *because* the thing being tested — does a
lapsed premium on `InsurancePolicy` actually block a claim on
`ClaimRegistry` — only exists at the boundary between the two real
contracts, and a mock would test nothing meaningful.

**What it consists of.** Two side-by-side containers, one per test
file, each listing its dependencies marked as real or mocked.

**What goes wrong without it.** A developer might apply "always mock
for unit tests" as a blanket rule and end up mocking away the exact
cross-contract interaction that was the actual point of a test like
`Premium.t.sol` — producing a test that passes reliably while proving
nothing about whether the real integration actually works.

---

## 8. The shape of this project's test coverage

<svg width="100%" viewBox="0 0 680 300" role="img" xmlns="http://www.w3.org/2000/svg">
<title>Test pyramid for this project</title>
<polygon points="300,40 380,40 420,100 260,100" fill="#E1F5EE" stroke="#0F6E56" stroke-width="1"/>
<text x="340" y="75" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#085041">none yet</text>
<polygon points="260,100 420,100 500,170 180,170" fill="#EEEDFE" stroke="#534AB7" stroke-width="1"/>
<text x="340" y="128" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#3C3489">Real-chain integration</text>
<text x="340" y="148" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#534AB7">oracle-service, indexer</text>
<polygon points="180,170 500,170 590,260 90,260" fill="#F1EFE8" stroke="#5F5E5A" stroke-width="1"/>
<text x="340" y="205" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#2c2c2a">Foundry unit tests</text>
<text x="340" y="228" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">57 test cases, 7 files</text>
<text x="440" y="48" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">Cross-service end-to-end</text>
</svg>

**Purpose.** Shows the actual *shape* of this project's test
confidence across three tiers, using this project's real counts rather
than a generic textbook pyramid.

**Why this diagram needed to exist.** A large raw test count feels
reassuring, but it's easy to mistake "57 tests pass" for comprehensive
confidence when almost all of that number sits in exactly one tier.

**What it explains.** 57 Foundry unit tests form a genuinely strong
base. A much smaller number of tests actually run against a real
Anvil chain — and only in two services, `oracle-service` and the
indexer. Zero tests exist anywhere in this project that exercise the
full, multi-service stack together end to end.

**What it consists of.** Three stacked trapezoid tiers, widest at the
base, each labeled with what it tests and how many tests actually
exist at that tier — including the top tier, labeled honestly as
"none yet" rather than omitted.

**What goes wrong without it.** A reviewer could look at "57 passing
tests" and reasonably but wrongly conclude the system as a whole is
well-verified, when in reality no test in this project has ever proven
that, for example, the Go notification service and the Java
underwriter service agree with each other against the same real chain
state at the same time — the exact kind of gap this pyramid's empty
top tier is deliberately drawn to surface, not hide.

---

## 9. `submitClaim`'s revert conditions, in order

<svg width="100%" viewBox="0 0 680 420" role="img" xmlns="http://www.w3.org/2000/svg">
<title>Decision tree for ClaimRegistry.submitClaim's three key checks</title>
<defs>
<marker id="a9" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M2 1L8 5L2 9" fill="none" stroke="#5f5e5a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</marker>
</defs>
<rect x="60" y="40" width="180" height="44" rx="8" fill="#F1EFE8" stroke="#5F5E5A" stroke-width="1"/>
<text x="150" y="67" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#2c2c2a">submitClaim called</text>
<rect x="60" y="120" width="180" height="44" rx="8" fill="#E6F1FB" stroke="#185FA5" stroke-width="1"/>
<text x="150" y="147" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#0C447C">Caller is holder?</text>
<rect x="470" y="120" width="170" height="44" rx="8" fill="#FCEBEB" stroke="#A32D2D" stroke-width="1"/>
<text x="555" y="147" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#791F1F">NotPolicyHolder</text>
<rect x="60" y="210" width="180" height="44" rx="8" fill="#E6F1FB" stroke="#185FA5" stroke-width="1"/>
<text x="150" y="237" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#0C447C">Premium current?</text>
<rect x="470" y="210" width="170" height="44" rx="8" fill="#FCEBEB" stroke="#A32D2D" stroke-width="1"/>
<text x="555" y="237" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="13" font-weight="600" fill="#791F1F">PremiumNotCurrent</text>
<rect x="60" y="300" width="180" height="44" rx="8" fill="#E6F1FB" stroke="#185FA5" stroke-width="1"/>
<text x="150" y="327" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#0C447C">Within coverage?</text>
<rect x="470" y="300" width="170" height="44" rx="8" fill="#FCEBEB" stroke="#A32D2D" stroke-width="1"/>
<text x="555" y="327" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="13" font-weight="600" fill="#791F1F">ExceedsCoverage</text>
<rect x="60" y="370" width="180" height="44" rx="8" fill="#E1F5EE" stroke="#0F6E56" stroke-width="1"/>
<text x="150" y="397" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#085041">Status: Submitted</text>
<line x1="150" y1="84" x2="150" y2="118" stroke="#5f5e5a" stroke-width="1.5" marker-end="url(#a9)"/>
<line x1="150" y1="164" x2="150" y2="208" stroke="#5f5e5a" stroke-width="1.5" marker-end="url(#a9)"/>
<line x1="150" y1="254" x2="150" y2="298" stroke="#5f5e5a" stroke-width="1.5" marker-end="url(#a9)"/>
<line x1="150" y1="344" x2="150" y2="368" stroke="#5f5e5a" stroke-width="1.5" marker-end="url(#a9)"/>
<line x1="240" y1="142" x2="466" y2="142" stroke="#5f5e5a" stroke-width="1.5" marker-end="url(#a9)"/>
<text x="254" y="132" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">no</text>
<line x1="240" y1="232" x2="466" y2="232" stroke="#5f5e5a" stroke-width="1.5" marker-end="url(#a9)"/>
<text x="254" y="222" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">no</text>
<line x1="240" y1="322" x2="466" y2="322" stroke="#5f5e5a" stroke-width="1.5" marker-end="url(#a9)"/>
<text x="254" y="312" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#5f5e5a">no</text>
</svg>

**Purpose.** Shows the exact order and content of the checks a real
`submitClaim` call has to pass, and which specific, named error comes
back at each possible failure point.

**Why this diagram needed to exist.** A list of `require`/`revert`
statements scattered through a function's source doesn't make their
*order* visually obvious, and order genuinely matters here — both for
gas (cheaper checks generally belong earlier) and for correctness (a
later check can safely assume an earlier one already passed, which
isn't obvious unless the order itself is visible).

**What it explains.** The caller-is-holder check runs first, the
premium-current check second, and the coverage check third — each with
its own distinct, named revert reason, only reaching the final
"Status: Submitted" write once all three have passed.

**What it consists of.** A chain of decision boxes running down the
left, each with a "no" branch to its own specifically named revert box
on the right, ending in one success box at the bottom.

**What goes wrong without it.** A developer writing a new caller
against this contract — or a new test — might not know *which*
specific check will fire first for a given invalid input, leading to a
test that asserts the wrong revert reason, or a misdiagnosed failure
where the real cause (say, a lapsed premium) gets mistaken for a
different one (say, insufficient coverage) simply because the actual
evaluation order wasn't visible.
