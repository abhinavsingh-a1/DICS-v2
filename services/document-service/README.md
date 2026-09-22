# document-service (.NET / ASP.NET Core)

Real document upload and a REAL Merkle tree over the results — closing
(partially — see below) the gap named repeatedly elsewhere in this
project: `frontend/src/api/contract.js`'s `placeholderMerkleRoot` hashes
plain description text, not actual evidence documents.

## What this does and does NOT close

Full explanation in `docs/tests-explained/17-Document-Service.md`. In
short: this service computes a real, correct Merkle root using
Keccak256 (matching Solidity's hash function — not .NET's built-in
SHA-3, a real and easy-to-miss distinction, see `MerkleTreeService.cs`).
What it does NOT do: `ClaimRegistry.sol` still accepts any `bytes32`
`merkleRoot` without verifying it against anything — there is no
on-chain Merkle proof verification anywhere in this project's
contracts. This service produces a root a future contract upgrade could
verify proofs against; it doesn't make the existing contract check
anything it didn't check before, and the frontend isn't yet wired to
call this service instead of its own placeholder.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| `POST` | `/claims/{claimId}/documents` | Upload one file (multipart), stores it, records its Keccak256 hash |
| `GET` | `/claims/{claimId}/documents` | List every uploaded document for a claim |
| `GET` | `/claims/{claimId}/merkle-root` | Computes the real Merkle root over all of a claim's documents |

## Running locally

```bash
dotnet restore
cp .env.example .env   # or just export the two variables directly
dotnet run
```

## Running the tests

```bash
cd document-service.Tests
dotnet test
```

No real filesystem or database needs to exist for these —
`MerkleTreeServiceTests` tests pure logic with no dependencies at all,
and `DocumentUploadServiceTests` replaces the real filesystem
(`IDocumentStorage`) with a Moq fake and the real database with EF
Core's `InMemory` provider. See `docs/tests-explained/17` for the full
walkthrough, and document `12` for the same underlying idea in Python.

## Docker

```bash
docker build -t dics-document-service .
docker run -v dics-documents:/data -p 8080:8080 dics-document-service
```

## Known limitations, stated directly

- Local disk storage, not real object storage (S3, IPFS) — see
  `LocalFileStorage.cs`. Fine for a single instance, not for durability
  or horizontal scaling.
- SQLite, not the shared Postgres the other services use — a
  deliberate scope choice, see `DocumentDbContext.cs`.
- The odd-node-duplication rule in the Merkle tree (see
  `MerkleTreeService.ComputeRoot`) has known theoretical weaknesses in
  adversarial settings — acceptable here since nothing on-chain
  currently verifies against this root at all (see above), but worth
  knowing before relying on it for anything higher-stakes.
- Not compiled or run by the assistant that wrote it — no .NET SDK was
  available in that environment. Run `dotnet build` before trusting
  this further.
