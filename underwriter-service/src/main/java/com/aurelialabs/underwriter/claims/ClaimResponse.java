package com.aurelialabs.underwriter.claims;

import java.math.BigDecimal;

/**
 * A separate class from ClaimEntity on purpose — returning JPA entities
 * directly from a REST controller is a common shortcut that tends to
 * leak internal persistence details (lazy-loading proxies, ID column
 * naming) straight into the API response. This record controls exactly
 * what shape the outside world sees, independent of how the database
 * table happens to be laid out.
 */
public record ClaimResponse(
        Long onchainClaimId,
        Long policyId,
        String claimantAddress,
        BigDecimal amount,
        String status,
        String submittedTxHash,
        String payoutTxHash
) {
    public static ClaimResponse from(ClaimEntity entity) {
        return new ClaimResponse(
                entity.getOnchainClaimId(),
                entity.getPolicyId(),
                entity.getClaimantAddress(),
                entity.getAmount(),
                entity.getStatus(),
                entity.getSubmittedTxHash(),
                entity.getPayoutTxHash()
        );
    }
}
