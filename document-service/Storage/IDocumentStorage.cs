namespace DicsV2.DocumentService.Storage;

/// <summary>
/// An interface, not a concrete class used directly everywhere — this
/// is what lets MerkleTreeServiceTests (and any future test) replace
/// real file I/O with an in-memory fake via Moq, the same underlying
/// idea as Mockito in the Java service and unittest.mock in the Python
/// backend, just C#'s idiom for it: depend on an interface, substitute
/// an implementation in tests.
/// </summary>
public interface IDocumentStorage
{
    Task<string> SaveAsync(long claimId, string fileName, Stream content, CancellationToken ct);
    Task<byte[]> ReadAsync(string storagePath, CancellationToken ct);
}

/// <summary>
/// Stores files on local disk, under a directory mounted as a Docker
/// volume (see Dockerfile / docker-compose.yml wiring) — NOT real
/// object storage (S3, IPFS, anything with real durability guarantees
/// or multi-instance access). Named directly as a placeholder, the same
/// way MockOracle and placeholderMerkleRoot are labeled elsewhere in
/// this project: this makes the upload/download flow genuinely work
/// end-to-end for a single instance, but does not solve durability,
/// backup, or horizontal scaling — real, unaddressed gaps a production
/// deployment would need to close.
/// </summary>
public class LocalFileStorage : IDocumentStorage
{
    private readonly string _rootDirectory;

    public LocalFileStorage(string rootDirectory)
    {
        _rootDirectory = rootDirectory;
        Directory.CreateDirectory(_rootDirectory);
    }

    public async Task<string> SaveAsync(long claimId, string fileName, Stream content, CancellationToken ct)
    {
        var claimDirectory = Path.Combine(_rootDirectory, claimId.ToString());
        Directory.CreateDirectory(claimDirectory);

        // Guid-prefixed filename — two people uploading a file with the
        // same name to the same claim must not silently overwrite each
        // other, which a bare fileName-only path would allow.
        var storedFileName = $"{Guid.NewGuid()}_{fileName}";
        var fullPath = Path.Combine(claimDirectory, storedFileName);

        await using var fileStream = File.Create(fullPath);
        await content.CopyToAsync(fileStream, ct);

        return fullPath;
    }

    public async Task<byte[]> ReadAsync(string storagePath, CancellationToken ct)
    {
        return await File.ReadAllBytesAsync(storagePath, ct);
    }
}
