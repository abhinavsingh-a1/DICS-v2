using DicsV2.DocumentService.Data;
using DicsV2.DocumentService.Merkle;
using DicsV2.DocumentService.Models;
using DicsV2.DocumentService.Storage;

namespace DicsV2.DocumentService.Services;

/// <summary>
/// The actual upload logic (hash, store, record), pulled out of
/// Program.cs's HTTP-handling lambda into its own class specifically so
/// it can be tested without spinning up a real ASP.NET Core server —
/// the same reasoning behind the Go service's standalone `ShouldNotify`
/// function and the Java service's separate `ClaimRegistryClient`: keep
/// the part worth testing separable from the part that's just HTTP
/// plumbing.
/// </summary>
public class DocumentUploadService
{
    private readonly DocumentDbContext _db;
    private readonly IDocumentStorage _storage;
    private readonly MerkleTreeService _merkle;

    public DocumentUploadService(DocumentDbContext db, IDocumentStorage storage, MerkleTreeService merkle)
    {
        _db = db;
        _storage = storage;
        _merkle = merkle;
    }

    public async Task<ClaimDocument> UploadAsync(
        long claimId, string fileName, string contentType, byte[] content, CancellationToken ct)
    {
        if (content.Length == 0)
        {
            throw new ArgumentException("Uploaded file is empty.", nameof(content));
        }

        var leafHash = _merkle.ComputeLeafHash(content);
        var hashHex = MerkleTreeService.ToHex(leafHash);

        using var stream = new MemoryStream(content);
        var storagePath = await _storage.SaveAsync(claimId, fileName, stream, ct);

        var document = new ClaimDocument
        {
            Id = Guid.NewGuid(),
            ClaimId = claimId,
            FileName = fileName,
            ContentType = contentType,
            SizeBytes = content.Length,
            KeccakHash = hashHex,
            StoragePath = storagePath,
            UploadedAt = DateTimeOffset.UtcNow,
        };

        _db.Documents.Add(document);
        await _db.SaveChangesAsync(ct);

        return document;
    }
}
