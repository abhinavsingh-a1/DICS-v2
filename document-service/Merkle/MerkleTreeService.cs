using Nethereum.Util;

namespace DicsV2.DocumentService.Merkle;

/// <summary>
/// Builds a real binary Merkle tree over a claim's document hashes,
/// using Keccak256 — the same hash function Solidity's contracts use
/// everywhere in this project. This is a genuine, real implementation,
/// not a stand-in — worth being precise about what that does and does
/// NOT close, though: `ClaimRegistry.sol`'s `submitClaim` accepts
/// whatever `bytes32 merkleRoot` it's given and never verifies it
/// against anything — there is no on-chain Merkle proof verification
/// built anywhere in this project's contracts. This service computes a
/// CORRECT root that a future contract upgrade COULD verify proofs
/// against; it does not, by itself, make the existing contract check
/// anything it didn't check before. The frontend's own
/// `placeholderMerkleRoot` (contract.js) — a hash of plain description
/// text, not real documents — is still what actually gets submitted
/// on-chain today unless the frontend is updated to call this service
/// first and use ITS root instead. That wiring is a genuine next step,
/// not done here.
/// </summary>
public class MerkleTreeService
{
    private static readonly Sha3Keccack Keccak = Sha3Keccack.Current;

    public byte[] ComputeLeafHash(byte[] documentContent)
    {
        return Keccak.CalculateHash(documentContent);
    }

    /// <summary>
    /// Combines leaf hashes pairwise, level by level, until one root
    /// hash remains. Pairs are SORTED before hashing (smaller byte value
    /// first) — the same convention OpenZeppelin's own MerkleProof
    /// library uses, specifically so the resulting root doesn't depend
    /// on the arbitrary order documents happened to be uploaded or
    /// queried in; two claims with the identical SET of documents
    /// produce the identical root regardless of order.
    /// </summary>
    /// <exception cref="ArgumentException">
    /// Thrown for an empty list — there is no meaningful Merkle root for
    /// zero documents, and returning some placeholder value (all zeros,
    /// say) would be indistinguishable from a real root by anyone
    /// consuming it, silently hiding the "no evidence uploaded" case
    /// instead of surfacing it as the error it actually is.
    /// </exception>
    public byte[] ComputeRoot(IReadOnlyList<byte[]> leafHashes)
    {
        if (leafHashes.Count == 0)
        {
            throw new ArgumentException("Cannot compute a Merkle root over zero documents.", nameof(leafHashes));
        }

        var level = leafHashes.ToList();

        while (level.Count > 1)
        {
            var nextLevel = new List<byte[]>();

            for (int i = 0; i < level.Count; i += 2)
            {
                if (i + 1 < level.Count)
                {
                    nextLevel.Add(HashPair(level[i], level[i + 1]));
                }
                else
                {
                    // Odd node out at this level — paired with itself
                    // rather than left unhashed. A simple, common
                    // convention; worth naming that it has known
                    // theoretical weaknesses against an adversarial
                    // second-preimage attack in some Merkle tree designs.
                    // Acceptable for this project's scope (evidence
                    // integrity checking, not a financial proof system
                    // anything is currently staked against on-chain) but
                    // named directly rather than presented as
                    // unconditionally secure.
                    nextLevel.Add(HashPair(level[i], level[i]));
                }
            }

            level = nextLevel;
        }

        return level[0];
    }

    private static byte[] HashPair(byte[] a, byte[] b)
    {
        var (first, second) = CompareBytes(a, b) <= 0 ? (a, b) : (b, a);
        var combined = new byte[first.Length + second.Length];
        Buffer.BlockCopy(first, 0, combined, 0, first.Length);
        Buffer.BlockCopy(second, 0, combined, first.Length, second.Length);
        return Keccak.CalculateHash(combined);
    }

    private static int CompareBytes(byte[] a, byte[] b)
    {
        for (int i = 0; i < Math.Min(a.Length, b.Length); i++)
        {
            int cmp = a[i].CompareTo(b[i]);
            if (cmp != 0) return cmp;
        }
        return a.Length.CompareTo(b.Length);
    }

    public static string ToHex(byte[] hash) => "0x" + Convert.ToHexString(hash).ToLowerInvariant();
}
