package com.aurelialabs.underwriter.claims;

import com.aurelialabs.underwriter.chain.ClaimRegistryClient;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/claims")
public class ClaimController {

    private final ClaimRepository claimRepository;
    private final ClaimRegistryClient claimRegistryClient;

    public ClaimController(ClaimRepository claimRepository, ClaimRegistryClient claimRegistryClient) {
        this.claimRepository = claimRepository;
        this.claimRegistryClient = claimRegistryClient;
    }

    /**
     * Every claim still awaiting a decision — this is the underwriter's
     * actual worklist. See ClaimRepository's own comment on why exactly
     * these two statuses, and ClaimEntity's header on why this reads the
     * INDEXER's table, not the backend's.
     */
    @GetMapping("/pending")
    public List<ClaimResponse> pendingClaims() {
        return claimRepository.findByStatusIn(List.of("Submitted", "UnderReview"))
                .stream()
                .map(ClaimResponse::from)
                .toList();
    }

    @GetMapping("/{claimId}")
    public ClaimResponse getClaim(@PathVariable long claimId) {
        ClaimEntity entity = claimRepository.findById(claimId)
                .orElseThrow(() -> new ClaimNotFoundException(claimId));
        return ClaimResponse.from(entity);
    }

    /**
     * Approves a claim — sends a REAL on-chain transaction. The
     * response only carries a transaction hash, not an updated status,
     * because the status hasn't actually changed yet from this service's
     * point of view — it changes once the transaction is MINED, and this
     * service finds out the same way anyone else would: the indexer
     * syncs the resulting event and this same GET /claims/{id} endpoint
     * reflects it on the next read. This is a deliberate, honest
     * reflection of how blockchains actually work — an HTTP 200 here
     * means "submitted," not "done."
     */
    @PostMapping("/{claimId}/approve")
    public TransactionResponse approve(@PathVariable long claimId) throws Exception {
        String txHash = claimRegistryClient.setClaimStatus(claimId, ClaimRegistryClient.ClaimStatus.APPROVED);
        return new TransactionResponse(txHash);
    }

    @PostMapping("/{claimId}/reject")
    public TransactionResponse reject(@PathVariable long claimId) throws Exception {
        String txHash = claimRegistryClient.setClaimStatus(claimId, ClaimRegistryClient.ClaimStatus.REJECTED);
        return new TransactionResponse(txHash);
    }

    /**
     * Only actually succeeds on-chain if the claim's real current status
     * is Approved — this endpoint doesn't check that itself beforehand;
     * see ClaimRegistryClient.payoutClaim's own comment on why that
     * check is deliberately left to the contract, the one place it can
     * never go stale.
     */
    @PostMapping("/{claimId}/payout")
    public TransactionResponse payout(@PathVariable long claimId) throws Exception {
        String txHash = claimRegistryClient.payoutClaim(claimId);
        return new TransactionResponse(txHash);
    }
}
