package com.aurelialabs.underwriter.chain;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.web3j.abi.FunctionEncoder;
import org.web3j.abi.datatypes.Function;
import org.web3j.abi.datatypes.generated.Uint256;
import org.web3j.abi.datatypes.generated.Uint8;
import org.web3j.crypto.Credentials;
import org.web3j.protocol.Web3j;
import org.web3j.protocol.core.methods.response.EthSendTransaction;
import org.web3j.protocol.http.HttpService;
import org.web3j.tx.RawTransactionManager;
import org.web3j.tx.gas.DefaultGasProvider;

import java.math.BigInteger;
import java.util.Collections;
import java.util.List;

/**
 * The one place in this service that actually sends a transaction — see
 * this class's own use of Credentials (a real private key, held in
 * memory only, never logged or persisted) for exactly why every other
 * class in this service is read-only. Same "single, minimal,
 * hand-written interface to the real contract" approach used throughout
 * this project — this class knows about exactly two functions,
 * setClaimStatus and payoutClaim, nothing more.
 *
 * Same acknowledged simplification as oracle-service's signer key (see
 * that service's own config comments): a single configured private key
 * held directly by this service, standing in for what a production
 * deployment would want to be the actual Underwriter Safe multisig,
 * with this service instead submitting a PROPOSAL to that Safe rather
 * than holding signing power outright. Flagged here rather than implied
 * to be production-ready as written.
 */
@Component
public class ClaimRegistryClient {

    // Matches the ClaimStatus enum ORDER declared in ClaimRegistry.sol
    // exactly — these are not arbitrary numbers, they're the literal
    // uint8 values Solidity assigns to each enum member by declaration
    // order. Getting this order wrong would not fail loudly; it would
    // silently set a DIFFERENT status than the one intended, which is
    // exactly why this mapping lives in exactly one place rather than
    // being re-typed as a raw integer at every call site.
    public enum ClaimStatus {
        SUBMITTED(0), UNDER_REVIEW(1), APPROVED(2), PAID(3), REJECTED(4);

        private final int ordinalValue;

        ClaimStatus(int ordinalValue) {
            this.ordinalValue = ordinalValue;
        }

        public BigInteger toUint8() {
            return BigInteger.valueOf(ordinalValue);
        }
    }

    private final Web3j web3j;
    private final Credentials credentials;
    private final String claimRegistryAddress;
    private final long chainId;

    public ClaimRegistryClient(
            @Value("${dics.rpc-url}") String rpcUrl,
            @Value("${dics.underwriter-private-key}") String underwriterPrivateKey,
            @Value("${dics.claim-registry-address}") String claimRegistryAddress,
            @Value("${dics.chain-id}") long chainId
    ) {
        this.web3j = Web3j.build(new HttpService(rpcUrl));
        this.credentials = Credentials.create(underwriterPrivateKey);
        this.claimRegistryAddress = claimRegistryAddress;
        this.chainId = chainId;
    }

    /**
     * Calls ClaimRegistry.setClaimStatus(claimId, status) — the manual
     * override path documented in the data-flow scenario set
     * (Scenario-7-Underwriter-Manual-Reject.md), now reachable through a
     * real API instead of only a raw contract call.
     */
    public String setClaimStatus(long claimId, ClaimStatus status) throws Exception {
        Function function = new Function(
                "setClaimStatus",
                List.of(new Uint256(BigInteger.valueOf(claimId)), new Uint8(status.toUint8())),
                Collections.emptyList() // no return value to decode — this function returns nothing
        );
        return sendTransaction(function);
    }

    /**
     * Calls ClaimRegistry.payoutClaim(claimId) — only succeeds on-chain
     * if the claim's status is currently Approved (see
     * docs/dataflow/Step-5-Payout.md); this method doesn't duplicate
     * that check client-side, it lets the real contract be the one
     * source of truth for whether payout is actually allowed right now.
     */
    public String payoutClaim(long claimId) throws Exception {
        Function function = new Function(
                "payoutClaim",
                List.of(new Uint256(BigInteger.valueOf(claimId))),
                Collections.emptyList()
        );
        return sendTransaction(function);
    }

    private String sendTransaction(Function function) throws Exception {
        String encodedFunction = FunctionEncoder.encode(function);

        RawTransactionManager txManager = new RawTransactionManager(web3j, credentials, chainId);

        // A fixed default gas provider rather than an estimated one —
        // fine for this project's local/test networks, a real
        // simplification for anything resembling mainnet, where gas
        // price should be estimated per-transaction. Named directly
        // rather than left implicit.
        EthSendTransaction response = txManager.sendTransaction(
                DefaultGasProvider.GAS_PRICE,
                DefaultGasProvider.GAS_LIMIT,
                claimRegistryAddress,
                encodedFunction,
                BigInteger.ZERO // no ETH sent alongside this call
        );

        if (response.hasError()) {
            throw new IllegalStateException(
                    "Transaction failed: " + response.getError().getMessage()
            );
        }
        return response.getTransactionHash();
    }
}
