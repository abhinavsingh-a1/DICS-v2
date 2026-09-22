package com.aurelialabs.underwriter.claims;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.math.BigDecimal;

/**
 * Maps to the INDEXER's onchain_claims table — deliberately not the
 * Python backend's own off-chain "claims" table. This follows the same
 * ownership boundary already established between the indexer and the
 * backend (see indexer/README.md): a table one service owns should not
 * be written to directly by a second, unrelated service. This service
 * never writes to this table at all — every field below is read-only
 * from this service's point of view. When an underwriter approves or
 * rejects a claim through this service, the actual change happens ON
 * CHAIN (see ClaimRegistryClient), and the indexer — which already owns
 * the job of mirroring on-chain truth into this exact table — picks up
 * the resulting event on its own next poll and updates this row itself.
 * This service reads the result of that later, the same way it read the
 * claim's existence in the first place.
 */
@Entity
@Table(name = "onchain_claims")
public class ClaimEntity {

    @Id
    @Column(name = "onchain_claim_id")
    private Long onchainClaimId;

    @Column(name = "policy_id")
    private Long policyId;

    @Column(name = "claimant_address")
    private String claimantAddress;

    @Column(name = "merkle_root")
    private String merkleRoot;

    @Column(name = "amount")
    private BigDecimal amount;

    /**
     * Stores the on-chain status NAME, not a number — matches exactly
     * what the indexer's own CLAIM_STATUS_NAMES array writes (see
     * indexer/src/rpcClient.js's comment on why that array's order is
     * load-bearing): "Submitted", "UnderReview", "Approved", "Paid", or
     * "Rejected". Kept as a plain String here rather than a Java enum
     * specifically so this entity never needs updating if the indexer's
     * exact string spelling ever changes — the enum mapping that DOES
     * need to stay in sync with the real contract lives in
     * ClaimRegistryClient (the numeric ordinals actually sent on-chain),
     * not here.
     */
    @Column(name = "status")
    private String status;

    @Column(name = "submitted_tx_hash")
    private String submittedTxHash;

    @Column(name = "payout_tx_hash")
    private String payoutTxHash;

    protected ClaimEntity() {
        // required no-arg constructor for JPA — Hibernate constructs
        // entities via reflection, never through application code calling
        // `new ClaimEntity(...)` directly, so this doesn't need to (and
        // shouldn't) validate anything the way a normal constructor would.
    }

    public Long getOnchainClaimId() {
        return onchainClaimId;
    }

    public Long getPolicyId() {
        return policyId;
    }

    public String getClaimantAddress() {
        return claimantAddress;
    }

    public String getMerkleRoot() {
        return merkleRoot;
    }

    public BigDecimal getAmount() {
        return amount;
    }

    public String getStatus() {
        return status;
    }

    public String getSubmittedTxHash() {
        return submittedTxHash;
    }

    public String getPayoutTxHash() {
        return payoutTxHash;
    }
}
