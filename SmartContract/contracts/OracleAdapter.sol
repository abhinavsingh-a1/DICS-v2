// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Minimal interface into ClaimRegistry — only the one function
///         this adapter needs to call.
interface IClaimRegistryOracleSink {
    function recordOracleVerification(uint256 claimId, bytes32 requestId, bool approved) external;
}

/// @title OracleAdapter (UUPS upgradeable, EIP-712)
/// @notice Verifies signed off-chain oracle attestations before forwarding
///         them to ClaimRegistry. This is the trust boundary
///         `ClaimRegistry.ORACLE_ROLE` should be granted to — never grant
///         ORACLE_ROLE directly to an EOA; grant it to this contract, and
///         let this contract enforce signer authorization, binding, and
///         expiry underneath it.
/// @dev Uses EIP-712 structured signing rather than raw EIP-191 so the
///      signed payload is unambiguous (typed fields, not a free-form
///      string) and bound to this specific contract + chain via the
///      domain separator — a signature produced for one deployment cannot
///      be replayed against another (e.g. a staging OracleAdapter vs. a
///      shared-Besu OracleAdapter), even if an authorized signer key is
///      reused across environments by mistake.
contract OracleAdapter is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable,
    UUPSUpgradeable
{
    using ECDSA for bytes32;

    // ──────────────────────────────────────────────────────────────
    // Roles
    // ──────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @dev Granted to whichever off-chain key(s) are authorized to sign
    ///      oracle attestations. Rotate via ADMIN_ROLE (timelock) if a key
    ///      is suspected compromised — revocation takes effect immediately
    ///      (no timelock delay on revoke by design; granting a NEW signer
    ///      still goes through ADMIN_ROLE's normal timelock path).
    bytes32 public constant ORACLE_SIGNER_ROLE = keccak256("ORACLE_SIGNER_ROLE");

    // ──────────────────────────────────────────────────────────────
    // EIP-712 type
    // ──────────────────────────────────────────────────────────────

    /// @dev Evaluated at compile time by solc since the argument is a
    ///      literal string constant — this is the standard EIP-712
    ///      typehash pattern (the same one OpenZeppelin's own contracts
    ///      use) and costs zero runtime gas. Do not replace this with a
    ///      hand-computed hex literal; a hand-copied hash is exactly the
    ///      kind of silent, hard-to-diagnose mismatch that makes every
    ///      signature fail verification with no obvious cause.
    bytes32 private constant ORACLE_RESPONSE_TYPEHASH =
        keccak256("OracleResponse(uint256 claimId,bytes32 requestId,bool approved,uint256 timestamp)");

    struct OracleResponse {
        uint256 claimId;
        bytes32 requestId;
        bool approved;
        uint256 timestamp;
    }

    // ──────────────────────────────────────────────────────────────
    // Storage
    // ──────────────────────────────────────────────────────────────

    IClaimRegistryOracleSink public claimRegistry;
    uint256 public responseValidityWindow; // seconds a signed response remains acceptable after its timestamp
    mapping(bytes32 => bool) public usedRequestIds; // adapter-level replay protection (defense in depth)

    uint256[45] private __gap;

    // ──────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────

    event VerificationSubmitted(
        uint256 indexed claimId,
        bytes32 indexed requestId,
        bool approved,
        address indexed signer
    );
    event ClaimRegistryUpdated(address newClaimRegistry);
    event ResponseValidityWindowUpdated(uint256 newWindowSeconds);

    // ──────────────────────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────────────────────

    error RequestAlreadyUsed();
    error ResponseExpired();
    error ResponseFromFuture();
    error UnauthorizedSigner();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address timelockAdmin,
        address claimRegistryAddress,
        uint256 responseValidityWindowSeconds
    ) external initializer {
        // v5 note: __AccessControl_init()/__Pausable_init()/
        // __UUPSUpgradeable_init() no longer exist — confirmed empty
        // no-ops as of v5.0.1, and removed entirely by a later v5.x
        // release (a real forge build reported __UUPSUpgradeable_init
        // as an undeclared identifier). Removing all three calls is
        // behaviorally identical to calling them, since they never did
        // anything — not skipped initialization, just a dead call.
        __EIP712_init("DICS-OracleAdapter", "1");

        _grantRole(DEFAULT_ADMIN_ROLE, timelockAdmin);
        _grantRole(ADMIN_ROLE, timelockAdmin);
        _grantRole(UPGRADER_ROLE, timelockAdmin);

        claimRegistry = IClaimRegistryOracleSink(claimRegistryAddress);
        responseValidityWindow = responseValidityWindowSeconds;
    }

    // ──────────────────────────────────────────────────────────────
    // Core: verify + relay
    // ──────────────────────────────────────────────────────────────

    /// @notice Anyone may call this — the security guarantee comes from
    ///         the ECDSA signature over the EIP-712 typed payload, not
    ///         from restricting the caller. This is the standard
    ///         "signed message, permissionless relay" pattern: an
    ///         authorized oracle signs off-chain, and any relayer
    ///         (the oracle's own service, a keeper, anyone) can submit it
    ///         on-chain without needing to hold a privileged role itself.
    function submitVerification(OracleResponse calldata response, bytes calldata signature)
        external
        whenNotPaused
    {
        if (usedRequestIds[response.requestId]) revert RequestAlreadyUsed();

        if (response.timestamp > block.timestamp) revert ResponseFromFuture();
        if (block.timestamp > response.timestamp + responseValidityWindow) revert ResponseExpired();

        bytes32 structHash = keccak256(
            abi.encode(
                ORACLE_RESPONSE_TYPEHASH,
                response.claimId,
                response.requestId,
                response.approved,
                response.timestamp
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);

        if (!hasRole(ORACLE_SIGNER_ROLE, signer)) revert UnauthorizedSigner();

        usedRequestIds[response.requestId] = true;

        claimRegistry.recordOracleVerification(response.claimId, response.requestId, response.approved);

        emit VerificationSubmitted(response.claimId, response.requestId, response.approved, signer);
    }

    // ──────────────────────────────────────────────────────────────
    // Admin
    // ──────────────────────────────────────────────────────────────

    function setClaimRegistry(address newClaimRegistry) external onlyRole(ADMIN_ROLE) {
        claimRegistry = IClaimRegistryOracleSink(newClaimRegistry);
        emit ClaimRegistryUpdated(newClaimRegistry);
    }

    function setResponseValidityWindow(uint256 newWindowSeconds) external onlyRole(ADMIN_ROLE) {
        responseValidityWindow = newWindowSeconds;
        emit ResponseValidityWindowUpdated(newWindowSeconds);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Exposes the domain separator so off-chain signing tooling
    ///         (the oracle service) can construct signatures that match
    ///         exactly what this contract will recover on-chain.
    function domainSeparatorV4() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Exposes the typehash so off-chain signing tooling and
    ///         tests can assert their locally-computed value matches this
    ///         contract's exactly, rather than trusting a copy-pasted
    ///         constant on either side.
    function oracleResponseTypehash() external pure returns (bytes32) {
        return ORACLE_RESPONSE_TYPEHASH;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}
