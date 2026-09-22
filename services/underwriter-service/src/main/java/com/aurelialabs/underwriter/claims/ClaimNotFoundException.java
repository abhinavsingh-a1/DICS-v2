package com.aurelialabs.underwriter.claims;

public class ClaimNotFoundException extends RuntimeException {
    public ClaimNotFoundException(long claimId) {
        super("Claim " + claimId + " not found");
    }
}
