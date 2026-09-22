using DicsV2.DocumentService.Merkle;
using Xunit;

namespace DicsV2.DocumentService.Tests;

/// <summary>
/// Pure logic tests — no mocking needed at all, since MerkleTreeService
/// has no dependencies (no database, no file I/O, no network). This is
/// worth noticing as a category distinct from DocumentUploadServiceTests
/// below: not every test needs a fake standing in for something real —
/// only code that actually TALKS to something external does. Testing
/// pure logic directly, with real inputs and real assertions, is both
/// simpler and a stronger guarantee than mocking would be here.
/// </summary>
public class MerkleTreeServiceTests
{
    private readonly MerkleTreeService _merkle = new();

    [Fact]
    public void ComputeRoot_SingleDocument_RootEqualsItsOwnLeafHash()
    {
        var leaf = _merkle.ComputeLeafHash("evidence-photo.jpg content bytes"u8.ToArray());

        var root = _merkle.ComputeRoot(new[] { leaf });

        // A tree of exactly one leaf has nothing to combine — the "root"
        // IS the leaf. Asserting this directly (rather than asserting a
        // specific hardcoded hash value neither of us can verify by eye)
        // checks the actual behavior that matters: no combination step
        // was wrongly applied to a single-element input.
        Assert.Equal(leaf, root);
    }

    [Fact]
    public void ComputeRoot_SameDocumentsInDifferentOrder_ProduceTheSameRoot()
    {
        var leafA = _merkle.ComputeLeafHash("document A"u8.ToArray());
        var leafB = _merkle.ComputeLeafHash("document B"u8.ToArray());
        var leafC = _merkle.ComputeLeafHash("document C"u8.ToArray());

        var rootInOneOrder = _merkle.ComputeRoot(new[] { leafA, leafB, leafC });
        var rootInAnotherOrder = _merkle.ComputeRoot(new[] { leafC, leafA, leafB });

        // This is the whole point of sorting each pair before hashing
        // (see MerkleTreeService.HashPair) — proven here directly rather
        // than just asserted in a comment. Two claims uploaded with the
        // same evidence in a different order must be recognized as
        // having the same evidence.
        Assert.Equal(rootInOneOrder, rootInAnotherOrder);
    }

    [Fact]
    public void ComputeRoot_DifferentDocumentSets_ProduceDifferentRoots()
    {
        var rootForTwoDocs = _merkle.ComputeRoot(new[]
        {
            _merkle.ComputeLeafHash("document A"u8.ToArray()),
            _merkle.ComputeLeafHash("document B"u8.ToArray()),
        });

        var rootForThreeDocs = _merkle.ComputeRoot(new[]
        {
            _merkle.ComputeLeafHash("document A"u8.ToArray()),
            _merkle.ComputeLeafHash("document B"u8.ToArray()),
            _merkle.ComputeLeafHash("document D"u8.ToArray()),
        });

        Assert.NotEqual(rootForTwoDocs, rootForThreeDocs);
    }

    [Fact]
    public void ComputeRoot_EmptyList_ThrowsRatherThanReturningAPlaceholder()
    {
        // See ComputeRoot's own doc comment on why this must throw, not
        // silently return some default value.
        Assert.Throws<ArgumentException>(() => _merkle.ComputeRoot(Array.Empty<byte[]>()));
    }

    [Fact]
    public void ComputeLeafHash_DifferentContent_ProducesDifferentHashes()
    {
        var hashOne = _merkle.ComputeLeafHash("content one"u8.ToArray());
        var hashTwo = _merkle.ComputeLeafHash("content two"u8.ToArray());

        Assert.NotEqual(hashOne, hashTwo);
    }
}
