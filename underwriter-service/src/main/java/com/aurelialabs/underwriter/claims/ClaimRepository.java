package com.aurelialabs.underwriter.claims;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface ClaimRepository extends JpaRepository<ClaimEntity, Long> {

    // Spring Data JPA generates the actual SQL for this from the method
    // name itself — no query written by hand here. "Submitted" and
    // "UnderReview" are the only two on-chain statuses an underwriter
    // can still act on; "Approved"/"Rejected"/"Paid" are all further
    // along than a pending review, so they're excluded by construction
    // rather than filtered out after the fact.
    List<ClaimEntity> findByStatusIn(List<String> statuses);
}
