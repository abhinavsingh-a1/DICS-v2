using DicsV2.DocumentService.Data;
using DicsV2.DocumentService.Merkle;
using DicsV2.DocumentService.Services;
using DicsV2.DocumentService.Storage;
using Microsoft.EntityFrameworkCore;
using Moq;
using Xunit;

namespace DicsV2.DocumentService.Tests;

/// <summary>
/// Compare this file's setup to test_policies.py's `_mock_contract_with`
/// (Python, `unittest.mock`) and `ClaimControllerTest`'s `@MockBean`
/// (Java, Mockito) — three different languages, three different
/// syntaxes, the exact same underlying idea each time: replace a real
/// dependency that would need a running external system (here: a real
/// filesystem) with a controllable fake, so the test can run in
/// milliseconds and control every input exactly.
/// </summary>
public class DocumentUploadServiceTests
{
    private static DocumentDbContext CreateInMemoryDb()
    {
        // A fresh, uniquely-named in-memory database per test — if every
        // test shared one database name, tests could see each other's
        // leftover data and interfere with one another, the same
        // isolation problem StaticPool/fresh-engine-per-test solves for
        // the Python backend's SQLite tests (see conftest.py).
        var options = new DbContextOptionsBuilder<DocumentDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;
        return new DocumentDbContext(options);
    }

    [Fact]
    public async Task UploadAsync_StoresDocumentAndRecordsCorrectHash()
    {
        await using var db = CreateInMemoryDb();
        var merkle = new MerkleTreeService();

        // Mock<IDocumentStorage> — Moq's equivalent of MagicMock (Python)
        // or @MockBean (Java). .Setup(...) is Moq's version of Python's
        // `side_effect`/`return_value` or Mockito's `when(...).thenReturn(...)`:
        // "when SaveAsync is called with ANY arguments (It.IsAny<...>()),
        // return this fixed fake path instead of touching a real disk."
        var storageMock = new Mock<IDocumentStorage>();
        storageMock
            .Setup(s => s.SaveAsync(It.IsAny<long>(), It.IsAny<string>(), It.IsAny<Stream>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync("/fake/storage/path/evidence.jpg");

        var service = new DocumentUploadService(db, storageMock.Object, merkle);
        var content = "fake evidence photo bytes"u8.ToArray();

        var result = await service.UploadAsync(
            claimId: 1, fileName: "evidence.jpg", contentType: "image/jpeg", content: content, CancellationToken.None);

        // Verifies the hash actually written matches what MerkleTreeService
        // itself would compute for the same bytes — proving
        // DocumentUploadService correctly wired the real hashing logic
        // in, not just that SOME hash string got stored.
        var expectedHash = MerkleTreeService.ToHex(merkle.ComputeLeafHash(content));
        Assert.Equal(expectedHash, result.KeccakHash);
        Assert.Equal("/fake/storage/path/evidence.jpg", result.StoragePath);

        var storedInDb = await db.Documents.FindAsync(result.Id);
        Assert.NotNull(storedInDb);
        Assert.Equal(1, storedInDb!.ClaimId);
    }

    [Fact]
    public async Task UploadAsync_EmptyContent_ThrowsWithoutTouchingStorageOrDatabase()
    {
        await using var db = CreateInMemoryDb();
        var merkle = new MerkleTreeService();
        var storageMock = new Mock<IDocumentStorage>();

        var service = new DocumentUploadService(db, storageMock.Object, merkle);

        await Assert.ThrowsAsync<ArgumentException>(() =>
            service.UploadAsync(1, "empty.txt", "text/plain", Array.Empty<byte>(), CancellationToken.None));

        // Verify(..., Times.Never) proves the mock's SaveAsync was never
        // even called — confirming the empty-content check short-circuits
        // BEFORE any storage attempt, not just that an exception happened
        // to be thrown somewhere. Same idea as the Java test's
        // `verify(claimRegistryClient).setClaimStatus(...)`, used here in
        // its negative form.
        storageMock.Verify(
            s => s.SaveAsync(It.IsAny<long>(), It.IsAny<string>(), It.IsAny<Stream>(), It.IsAny<CancellationToken>()),
            Times.Never);
        Assert.Empty(db.Documents);
    }
}
