# 07 — `document-service` (.NET/ASP.NET Core): Run & Test Locally

## Communicates with (see `00-Communication-Map.md`)
**Nothing else in this project, in either direction.** Its own SQLite
database and local disk only. This is the one real gap named in the
communication map — the frontend isn't yet wired to upload here or use
its computed Merkle root, and nothing reads its stored files back out
anywhere in the UI. Fully functional on its own; just not yet connected
to the rest of the system.

## Run locally

```bash
cd document-service
dotnet restore
cp .env.example .env   # or export STORAGE_ROOT / DATABASE_PATH directly
dotnet run
```

Verify it's up: `curl http://localhost:8080/health` → `{"status":"ok"}`.

Try it end-to-end manually:

```bash
curl -F "file=@/path/to/some/test-file.jpg" http://localhost:8080/claims/1/documents
curl http://localhost:8080/claims/1/documents
curl http://localhost:8080/claims/1/merkle-root
```

## Run the tests

```bash
cd document-service.Tests
dotnet test
```

No real filesystem or database needs to exist — `MerkleTreeServiceTests`
is pure logic with zero dependencies, and `DocumentUploadServiceTests`
replaces the real filesystem with a Moq fake and the real database with
EF Core's `InMemory` provider (see document `17` for the full
walkthrough, including a worked-by-hand Merkle tree example).
