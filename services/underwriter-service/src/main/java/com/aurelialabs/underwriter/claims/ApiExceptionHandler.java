package com.aurelialabs.underwriter.claims;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.Map;

/**
 * Without this, an unhandled exception (a missing claim, a failed
 * on-chain transaction) would fall through to Spring Boot's generic
 * whitelabel error page — technically a response, but not a useful one
 * for anything calling this API programmatically. This turns the two
 * failure modes this service actually has into clean, predictable JSON.
 */
@RestControllerAdvice
public class ApiExceptionHandler {

    @ExceptionHandler(ClaimNotFoundException.class)
    public ResponseEntity<Map<String, String>> handleNotFound(ClaimNotFoundException ex) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("detail", ex.getMessage()));
    }

    @ExceptionHandler(IllegalStateException.class)
    public ResponseEntity<Map<String, String>> handleChainFailure(IllegalStateException ex) {
        // Covers ClaimRegistryClient's own thrown exception when a
        // transaction itself reports an error — e.g. the contract
        // reverting because the claim wasn't actually in a state that
        // allows this action (the same real revert conditions documented
        // in the data-flow scenario set, now surfacing through HTTP
        // instead of a raw JSON-RPC error).
        return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("detail", ex.getMessage()));
    }
}
