# 16 — `underwriter-service` (Java / Spring Boot): Purpose, Design, and Data Flow

This document assumes you've read `11` and `12`. Spring Boot's own
conventions — dependency injection via constructor parameters,
annotations doing work that would be explicit code in Python or Go,
`@WebMvcTest`'s narrow test scope — are explained here from scratch.

## What is the purpose of this service, in one sentence?

It's the underwriter's actual worklist and decision-making tool — real
REST endpoints for `setClaimStatus` and `payoutClaim`, which before this
service existed were reachable only via a raw contract call (a wallet,
a block explorer, or a script — never a real application).

## Why does `ClaimEntity` map to the INDEXER's `onchain_claims` table, not the Python backend's own `claims` table?

This is explained once, directly, in `ClaimEntity.java`'s own header
comment — worth restating here because it's the single most important
architectural decision in this service, not just a detail. Two services
both writing to the same table, each with their own idea of when and
how, is exactly the kind of thing that causes silent data corruption
over time (one writer's update overwriting the other's in-flight
change, differing validation rules, etc.) — the indexer's own README
already names this as a boundary it respects (see document `11`'s
reference to the indexer/backend split). This service extends that same
principle: it reads the indexer's mirror of on-chain truth, and when it
*changes* that truth (by sending a real transaction), it lets the
indexer — which already owns the job of syncing on-chain events into
this exact table — pick up the result on its own, rather than trying to
update the row itself and risk the two writers disagreeing.

## Walking through Spring's dependency injection, for anyone who's only seen manual wiring

Compare `ClaimController`'s constructor:

```java
public ClaimController(ClaimRepository claimRepository, ClaimRegistryClient claimRegistryClient) {
    this.claimRepository = claimRepository;
    this.claimRegistryClient = claimRegistryClient;
}
```

**Nowhere in this codebase does anything call `new ClaimController(...)`
directly.** Spring Boot scans for classes annotated `@RestController`
(on `ClaimController`), `@Component` (on `ClaimRegistryClient`), and
interfaces extending `JpaRepository` (`ClaimRepository`, which Spring
Data JPA auto-implements — there's no hand-written class implementing
it anywhere in this project at all), and *automatically* constructs
each one, feeding each constructor whatever other Spring-managed
objects it asks for by type. This is "dependency injection": a class
declares what it needs as constructor parameters, and a framework
supplies real instances of those things at startup, rather than the
class constructing its own dependencies internally.

**What would happen without Spring managing this:** every class would
need to manually construct its own dependencies (`new ClaimRepository()`
— except that's not even possible, since `ClaimRepository` is just an
interface with no hand-written implementation at all; Spring Data JPA
*generates* the real implementation at startup, another thing that
simply wouldn't exist without the framework doing this work).

## Data flow inside `ClaimRegistryClient.setClaimStatus`, with concrete values

Using the same claim from the data-flow documents' Scenario 7 (an
underwriter manually rejecting claim 1):

- **Input:** `claimId = 1`, `status = ClaimStatus.REJECTED`
- **Line by line:**
  1. `status.toUint8()` — `ClaimStatus.REJECTED`'s constructor was
     called with `4` when the enum itself was declared
     (`REJECTED(4)`), so this returns `BigInteger.valueOf(4)`.
     **Why this number specifically:** it must match the literal
     position `Rejected` occupies in `ClaimRegistry.sol`'s own
     `enum ClaimStatus { Submitted, UnderReview, Approved, Paid, Rejected }`
     declaration — Solidity enums are just named integers, counting
     from `0` in declaration order. Getting this number wrong wouldn't
     cause a compile error or an obvious crash; it would silently set
     the WRONG status on-chain, which is exactly why this mapping is
     written once, in exactly one place, with a comment explaining
     precisely why it can't be treated as an arbitrary number.
  2. `new Function("setClaimStatus", List.of(new Uint256(BigInteger.valueOf(1)), new Uint8(BigInteger.valueOf(4))), Collections.emptyList())`
     — builds a description of the function call: its name, its two
     typed arguments, and an empty list for return types (since
     `setClaimStatus` returns nothing).
  3. `FunctionEncoder.encode(function)` — turns that description into
     the actual raw calldata bytes: the 4-byte selector for
     `setClaimStatus(uint256,uint8)`, followed by the encoded `1` and
     `4`.
  4. `new RawTransactionManager(web3j, credentials, chainId)` — this is
     what actually knows how to sign: it reads the underwriter
     account's current transaction count (`nonce`) from the chain,
     builds a full transaction, and signs it using the private key
     wrapped inside `credentials`.
  5. `txManager.sendTransaction(gasPrice, gasLimit, claimRegistryAddress, encodedFunction, BigInteger.ZERO)`
     — broadcasts the signed transaction to the network. This is the
     real, on-chain-state-changing step; everything before it was just
     preparation.
  6. `response.hasError()` — checks whether the JSON-RPC call itself
     failed (a malformed transaction, a node connectivity issue) — note
     this is checking whether the transaction was **successfully
     submitted**, not whether it will ultimately succeed once mined
     (a transaction can be submitted successfully and still revert
     later — this method doesn't wait for mining at all, matching
     `ClaimController`'s own doc comment on why an HTTP 200 here means
     "submitted," not "done").
- **Output:** `response.getTransactionHash()` — a transaction hash
  string like `"0xabc123..."`, returned all the way back up through
  `ClaimController.reject` as `{"txHash": "0xabc123..."}`.

## Why does `ApiExceptionHandler` exist as its own separate class, rather than try/catch blocks inside `ClaimController`?

The `@RestControllerAdvice` annotation makes this class apply
*globally* — to every controller in the application, not just
`ClaimController`. Today there's only one controller, so the practical
difference is small, but the design intent is real: exception-to-HTTP-
response translation is a cross-cutting concern (the same two exception
types could just as easily be thrown from a future second controller),
and keeping that translation in one place means `ClaimController`'s own
methods stay focused on "what does this endpoint do," not cluttered
with repeated `try { ... } catch (ClaimNotFoundException e) { return
ResponseEntity.status(404)... }` blocks in every single method.

## Walking through `ClaimControllerTest`'s `@WebMvcTest`, for anyone who's only seen full end-to-end tests

```java
@WebMvcTest(ClaimController.class)
class ClaimControllerTest {
    @Autowired private MockMvc mockMvc;
    @MockBean private ClaimRepository claimRepository;
    @MockBean private ClaimRegistryClient claimRegistryClient;
```

**What `@WebMvcTest` actually starts, and what it deliberately doesn't:**
a real, in-memory HTTP request-handling pipeline — routing, JSON
serialization, the actual `ClaimController` class — but explicitly
*not* a real database connection, and *not* a real Spring Data JPA
repository implementation. `@MockBean` is what makes this possible:
it tells Spring "wherever something in this test context needs a
`ClaimRepository`, hand it this Mockito mock instead of trying to build
a real one." This is architecturally the same idea as `@WebMvcTest`'s
Python-world cousin — the FastAPI backend's tests use a real (if
temporary) SQLite database rather than mocking SQLAlchemy directly (see
`backend/tests/conftest.py`), while this Java test goes one level
further and mocks the *repository interface itself*, never touching any
database engine at all, real or in-memory. Both are valid, common
choices — the trade-off is real database behavior (constraints, actual
SQL) versus milliseconds-fast, fully controlled test data.

Walking through `approve_callsSetClaimStatusWithApprovedAndReturnsTxHash`:

1. `when(claimRegistryClient.setClaimStatus(eq(1L), eq(ClaimRegistryClient.ClaimStatus.APPROVED))).thenReturn("0xabc123")`
   — programs the mock: when *exactly* this method is called with
   *exactly* these arguments, return this fixed string instead of
   trying to sign and broadcast a real transaction.
2. `mockMvc.perform(post("/claims/1/approve"))` — simulates an actual
   HTTP POST request hitting this running (test) application, without
   an actual network socket or real HTTP server involved.
3. `.andExpect(jsonPath("$.txHash").value("0xabc123"))` — parses the
   real JSON response body and checks the `txHash` field matches.
4. `verify(claimRegistryClient).setClaimStatus(1L, ClaimRegistryClient.ClaimStatus.APPROVED)`
   — this line is checking something *different* from step 3: not what
   came back, but that the controller correctly called the mock with
   the right arguments in the first place. A bug where the controller
   accidentally called `setClaimStatus(1L, ClaimStatus.REJECTED)` but
   the mock still happened to return `"0xabc123"` regardless of
   arguments would pass step 3's assertion but fail this one — which is
   exactly why both checks exist, not just one.
