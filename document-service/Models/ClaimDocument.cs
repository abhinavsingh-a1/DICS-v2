namespace DicsV2.DocumentService.Models;

/// <summary>
/// One uploaded evidence file for one claim. `KeccakHash` (not a SHA-256
/// hash, deliberately — see DocumentService.csproj's comment on why) is
/// both this document's content-identity check and the leaf value used
/// when this claim's documents are combined into a Merkle root.
/// </summary>
public class ClaimDocument
{
    public Guid Id { get; set; }
    public long ClaimId { get; set; }
    public required string FileName { get; set; }
    public required string ContentType { get; set; }
    public long SizeBytes { get; set; }

    /// <summary>
    /// Hex-encoded (0x-prefixed), matching how every other hash value in
    /// this project is represented — the same string shape ClaimRegistry.sol's
    /// merkleRoot field expects, InsurancePolicy.sol's metadataHash uses,
    /// and every ABI fragment across this project's other services
    /// declares as `bytes32`.
    /// </summary>
    public required string KeccakHash { get; set; }

    /// <summary>
    /// Where the actual file bytes live on disk — see LocalFileStorage's
    /// own header on why this is local disk, not real object storage,
    /// and what that means for this service in a real deployment.
    /// </summary>
    public required string StoragePath { get; set; }

    public DateTimeOffset UploadedAt { get; set; }
}
