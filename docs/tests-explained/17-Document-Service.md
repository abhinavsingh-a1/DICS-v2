# 17 — `document-service` (.NET / ASP.NET Core): Purpose, Design, and a Worked Merkle Tree Example

This document assumes you've read `11` and `12`. .NET's own conventions
— minimal APIs, dependency injection via `builder.Services`, the
`IDisposable`/`using` pattern for resource cleanup — are explained here
from scratch.

## What is the purpose of this service, in one sentence?

Real evidence-document upload, with a genuine Merkle tree computed over
the results — replacing, if wired in, the frontend's
`placeholderMerkleRoot` (`contract.js`), which today just hashes a
plain text description rather than any actual document.

**Read this carefully before assuming more is fixed than actually is:**
`ClaimRegistry.sol` still accepts any `bytes32 merkleRoot` value with no
verification against anything at all — there is no Merkle proof
verification logic anywhere in this project's contracts. This service
makes it *possible* to compute a root that a future contract upgrade
could verify real proofs against. It does not, by itself, change what
the existing contract checks, and the frontend has not been updated to
call this service instead of its own placeholder. Both are real,
separate pieces of unfinished work — named directly rather than implied
to be solved by this service's existence.

## A full worked Merkle tree example, by hand, before reading any code

Say a claim has three uploaded documents: a photo, a receipt, and a
police report. Call their content hashes (after `ComputeLeafHash`) `A`,
`B`, and `C` — three 32-byte values. Building the tree:

```
Level 0 (leaves):        A        B        C
                          \       /         |
Level 1:              Hash(A,B)      Hash(C,C)   <- C has no partner, paired with itself
                              \        /
Level 2 (root):            Hash( Hash(A,B), Hash(C,C) )
```

**Why `C` gets paired with itself** rather than left alone at this
level: a Merkle tree needs every level to combine pairs down to exactly
one root; an odd node with no partner has to go somewhere, and pairing
it with itself is the simplest, most common convention for that case
(see `MerkleTreeService.ComputeRoot`'s own comment on this rule's real,
acknowledged limitations).

**Why each pair is sorted before hashing** (`Hash(A,B)`, not sometimes
`Hash(A,B)` and sometimes `Hash(B,A)` depending on upload order):
imagine uploading the photo first, then the receipt — versus a *second*
claim where the same two documents are uploaded receipt-first. Without
sorting, these would produce two *different* combined hashes for
*identical* evidence, purely because of upload order — clearly wrong,
since the actual evidence is the same. Sorting each pair by byte value
before combining means the final root only depends on *which*
documents were uploaded, never the order they arrived in — proven
directly, with real values, in `MerkleTreeServiceTests.ComputeRoot_SameDocumentsInDifferentOrder_ProduceTheSameRoot`.

## Why Keccak256 and not .NET's built-in `SHA3_256`?

This is worth being precise about, because the names are deceptively
similar and the mistake is easy to make silently. NIST standardized
SHA-3 in 2015, based on the Keccak algorithm — but changed one detail
of the padding scheme during standardization. Ethereum was built
*before* that standardization finished, using the *original* Keccak
padding. The result: `Keccak256(x)` and `SHA3-256(x)` produce
**completely different output** for the same input `x`, despite Keccak
being SHA-3's direct ancestor. `.NET`'s built-in
`System.Security.Cryptography.SHA3_256` implements the *later,
standardized* version — using it here would silently produce a root
that could never match what a Solidity contract computes with its own
`keccak256`. `Nethereum.Util.Sha3Keccack` implements the *original*
Ethereum-compatible version — the one actually needed for this root to
ever be verifiable on-chain.

## Data flow inside `DocumentUploadService.UploadAsync`, with concrete values

Uploading a photo file (some raw JPEG bytes) as evidence for claim 1:

- **Input:** `claimId = 1`, `fileName = "flight-cancellation-notice.jpg"`,
  `contentType = "image/jpeg"`, `content` (the raw file bytes, say
  240,000 bytes long)
- **Line by line:**
  1. `if (content.Length == 0) throw new ArgumentException(...)` — the
     empty-file guard, checked FIRST, before any hashing or storage
     work begins. `DocumentUploadServiceTests.UploadAsync_EmptyContent_ThrowsWithoutTouchingStorageOrDatabase`
     proves this ordering directly — the mock's `SaveAsync` is verified
     as *never called* for this case, not just that an exception
     happened somewhere.
  2. `_merkle.ComputeLeafHash(content)` — runs Keccak256 over the full
     240,000 raw bytes, producing a 32-byte hash, e.g.
     `0x7a3f...` (illustrative — the real value depends on the file's
     actual bytes).
  3. `MerkleTreeService.ToHex(leafHash)` — converts those 32 raw bytes
     into the string form `"0x7a3f..."`, matching how every other hash
     in this project is represented as text.
  4. `_storage.SaveAsync(1, "flight-cancellation-notice.jpg", stream, ct)`
     — writes the file to
     `/data/documents/1/3f9a2b1c-..._flight-cancellation-notice.jpg`
     (a GUID-prefixed name, inside a per-claim subdirectory — see
     `LocalFileStorage.SaveAsync`'s own comment on why the GUID prefix
     exists).
  5. A new `ClaimDocument` is constructed with a fresh `Guid` ID, the
     computed hash, the returned storage path, and the current
     timestamp.
  6. `_db.Documents.Add(document); await _db.SaveChangesAsync(ct);` —
     the metadata (not the file bytes themselves — those already live
     on disk from step 4) is written to SQLite.
- **Output:** the constructed `ClaimDocument` object, which
  `Program.cs`'s endpoint handler turns into the HTTP response
  `{ "id": "...", "fileName": "flight-cancellation-notice.jpg", "keccakHash": "0x7a3f...", "sizeBytes": 240000, "uploadedAt": "..." }`.

## Why does `Program.cs`'s endpoint read the whole file into a `MemoryStream` before doing anything else with it?

```csharp
await using var memoryStream = new MemoryStream();
await file.CopyToAsync(memoryStream, ct);
```

A `Stream` in .NET (and most languages) is generally a *forward-only*
read — once you've read through it, there's no going back to the start
without support for "seeking." `DocumentUploadService` needs the file's
bytes twice: once to compute its hash, once to actually save it. Rather
than relying on `IFormFile`'s underlying stream supporting seek-back
(which depends on implementation details — small uploads might be
buffered in memory, but large ones are often streamed from a temp file
in ways that don't always support clean re-reading), the endpoint reads
the whole upload into a `byte[]` exactly once, then that same
already-loaded array is used for both the hash and the save — simpler
and more predictable than depending on stream-seeking behavior that
could vary by upload size.

## Walking through the Moq test's `Times.Never` assertion

```csharp
storageMock.Verify(
    s => s.SaveAsync(It.IsAny<long>(), It.IsAny<string>(), It.IsAny<Stream>(), It.IsAny<CancellationToken>()),
    Times.Never);
```

This is checking the *absence* of a call, not its presence — a
different, and easy to forget, kind of assertion. Without this line,
`UploadAsync_EmptyContent_ThrowsWithoutTouchingStorageOrDatabase` would
only prove that *an exception was thrown* — it would NOT prove that the
empty-content check happens *before* any storage work is attempted. A
bug where the code tried to save an empty file to disk and only
*afterward* threw an exception would still pass a test that checked
only for the exception — `Times.Never` is what actually proves the
short-circuit ordering the method's own logic depends on.
