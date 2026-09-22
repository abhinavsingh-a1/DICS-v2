package com.aurelialabs.underwriter.claims;

import com.aurelialabs.underwriter.chain.ClaimRegistryClient;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

import java.math.BigDecimal;
import java.util.List;
import java.util.Optional;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * @WebMvcTest loads ONLY the web layer (controllers, exception
 * handlers) — not the real database, not a real Spring Data JPA
 * repository implementation, not a real web3j connection. Both
 * ClaimRepository and ClaimRegistryClient are replaced with Mockito
 * mocks via @MockBean, the Spring-aware equivalent of what
 * unittest.mock.patch does in the Python backend's test_policies.py
 * (see docs/tests-explained/12) — same underlying idea (swap a real
 * dependency for a controllable fake during the test), different
 * language's idiom for expressing it. No Postgres or Anvil needs to be
 * running for any test in this file.
 */
@WebMvcTest(ClaimController.class)
class ClaimControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private ClaimRepository claimRepository;

    @MockBean
    private ClaimRegistryClient claimRegistryClient;

    @Test
    void pendingClaims_returnsOnlySubmittedAndUnderReview() throws Exception {
        ClaimEntity submitted = buildEntity(1L, "Submitted");
        // when() ... thenReturn() is Mockito's core pattern: "when this
        // exact method is called with these exact arguments, return this
        // canned value instead of running real logic" — here,
        // claimRepository.findByStatusIn(...) never touches a real
        // database at all; it just hands back this fixed list.
        when(claimRepository.findByStatusIn(List.of("Submitted", "UnderReview")))
                .thenReturn(List.of(submitted));

        mockMvc.perform(get("/claims/pending"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].onchainClaimId").value(1))
                .andExpect(jsonPath("$[0].status").value("Submitted"));
    }

    @Test
    void getClaim_returns404WhenNotFound() throws Exception {
        when(claimRepository.findById(99L)).thenReturn(Optional.empty());

        mockMvc.perform(get("/claims/99"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.detail").value("Claim 99 not found"));
    }

    @Test
    void approve_callsSetClaimStatusWithApprovedAndReturnsTxHash() throws Exception {
        when(claimRegistryClient.setClaimStatus(eq(1L), eq(ClaimRegistryClient.ClaimStatus.APPROVED)))
                .thenReturn("0xabc123");

        mockMvc.perform(post("/claims/1/approve"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.txHash").value("0xabc123"));

        // verify() checks the mock was ACTUALLY called with these exact
        // arguments — this is what proves the controller wired the HTTP
        // request through to the right chain call with the right claim
        // ID and the right status, not just that SOME response came back.
        verify(claimRegistryClient).setClaimStatus(1L, ClaimRegistryClient.ClaimStatus.APPROVED);
    }

    @Test
    void payout_surfacesChainFailureAsConflict() throws Exception {
        // Simulates a real on-chain revert (e.g. the claim isn't
        // actually Approved) without needing a real contract to revert —
        // exactly the same "make the mock throw" pattern the Go
        // notification service's tests use for a different reason, and
        // the Python backend's test_policies.py uses for its 404 case.
        when(claimRegistryClient.payoutClaim(1L))
                .thenThrow(new IllegalStateException("execution reverted: ClaimNotApproved"));

        mockMvc.perform(post("/claims/1/payout"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.detail").value("execution reverted: ClaimNotApproved"));
    }

    private ClaimEntity buildEntity(long id, String status) {
        // ClaimEntity's fields are all private with no public
        // constructor (see its own header on why — Hibernate builds
        // entities via reflection). Tests need a way around that too;
        // ReflectionTestUtils (Spring's test-only utility for exactly
        // this) sets private fields directly, the same way Hibernate
        // itself would.
        ClaimEntity entity = new ClaimEntity();
        org.springframework.test.util.ReflectionTestUtils.setField(entity, "onchainClaimId", id);
        org.springframework.test.util.ReflectionTestUtils.setField(entity, "policyId", 1L);
        org.springframework.test.util.ReflectionTestUtils.setField(entity, "claimantAddress", "0x1111111111111111111111111111111111AAAA");
        org.springframework.test.util.ReflectionTestUtils.setField(entity, "amount", new BigDecimal("221"));
        org.springframework.test.util.ReflectionTestUtils.setField(entity, "status", status);
        return entity;
    }
}
