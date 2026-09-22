// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
// v5 note: OpenZeppelin stopped shipping ReentrancyGuardUpgradeable —
// ReentrancyGuard was reclassified "stateless" and the plain
// (non-upgradeable) version is used directly even in upgradeable
// contracts; it needs no constructor/initializer call. Confirmed via
// OpenZeppelin's own v5 release notes after this exact import broke a
// real forge build with "file not found."
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Minimal interface into InsurancePolicy — duplicates the Policy
///         struct shape (not a full import) specifically to avoid a
///         circular/heavy dependency between the two contracts. Solidity
///         resolves external calls structurally (by selector + ABI
///         encoding), so this only works correctly if the field order and
///         types below stay in lockstep with InsurancePolicy.sol's actual
///         Policy struct — if that struct changes, this must change too.
interface IInsurancePolicyRegistry {
    struct Policy {
        uint128 policyId;
        uint128 coverageAmount;
        address holder;
        uint40 validFrom;
        uint40 validUntil;
        bool revoked;
        bytes32 metadataHash;
    }

    function getPolicy(uint256 policyId) external view returns (Policy memory);

    /// @dev Added alongside InsurancePolicy's premium module. A single
    ///      extra function on the interface — no change needed to the
    ///      Policy struct above, so nothing that already depends on that
    ///      struct's shape (this file's own storage, the Foundry mock in
    ///      ClaimRegistryUpgrade.t.sol) needed to change to add this.
    function isPremiumCurrent(uint256 policyId) external view returns (bool);
}

/// @title ClaimRegistry (UUPS upgradeable)
/// @notice Core claim lifecycle contract for DICS v2. Deployed behind an
///         ERC1967Proxy. All privileged roles (ADMIN_ROLE, UPGRADER_ROLE)
///         are expected to be held by a TimelockController, not an EOA or
///         even a raw Safe multisig directly — see deployment README.
/// @dev Storage layout: do not reorder existing state variables in future
///      versions. Only append new variables above __gap, and shrink __gap
///      by the same number of slots consumed.
contract ClaimRegistry is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────────────────────
    // Roles
    // ──────────────────────────────────────────────────────────────

    /// @dev Intended holder: TimelockController. Governs role grants,
    ///      parameter changes, and (via _authorizeUpgrade) contract upgrades.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @dev Intended holder: TimelockController, same as ADMIN_ROLE in most
    ///      deployments, but kept distinct so upgrade authority can be
    ///      scoped separately if the org later wants a different threshold.
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    /// @dev Intended holder: individual signers or a low-threshold Safe.
    ///      Deliberately a *lighter* bar than ADMIN_ROLE — pausing is the
    ///      safe/conservative action and should be fast. Unpausing requires
    ///      ADMIN_ROLE (i.e. goes through the timelock).
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @dev Intended holder: underwriter Safe (multisig), not a single EOA.
    bytes32 public constant UNDERWRITER_ROLE = keccak256("UNDERWRITER_ROLE");

    /// @dev Intended holder: authorized oracle signer / oracle adapter.
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    // ──────────────────────────────────────────────────────────────
    // Types
    // ──────────────────────────────────────────────────────────────

    enum ClaimStatus {
        Submitted,
        UnderReview,
        Approved,
        Paid,
        Rejected
    }

    struct Claim {
        uint128 claimId;       // packed together with policyId below
        uint128 policyId;
        address claimant;
        uint96 amount;         // sized down deliberately; see NOTE below
        ClaimStatus status;
        uint40 submittedAt;
        uint40 processedAt;
        bytes32 merkleRoot;
    }
    // NOTE: amount is uint96 to keep the struct packed into fewer storage
    // slots. This supports payout amounts up to ~7.9 * 10^28 in the token's
    // smallest unit — more than sufficient for an 18-decimal ERC-20 at any
    // realistic claim size, but MUST be revisited if the payout token uses
    // an unusually high decimals value. This is documented explicitly
    // because silent truncation of a financial amount is exactly the kind
    // of bug a gas-optimization pass must not introduce quietly.

    // ──────────────────────────────────────────────────────────────
    // Storage (append-only across upgrades — see __gap)
    // ──────────────────────────────────────────────────────────────

    uint256 public nextClaimId;

    mapping(uint256 => Claim) public claims;
    mapping(uint256 => uint256[]) public policyClaims;
    mapping(bytes32 => bool) public usedOracleRequestIds; // replay protection

    IERC20 public payoutToken;
    address public policyRegistry; // InsurancePolicy contract, for active-policy checks

    // Rate limiting
    uint256 public maxPayoutPerClaim;
    uint256 public maxPayoutPerWindow;
    uint256 public rateLimitWindowSeconds;
    uint256 private _windowStart;
    uint256 private _windowTotalPaid;

    /// @dev Reserved storage gap for future upgrades. Reduce this number by
    ///      exactly the number of new slots any future version adds.
    uint256[42] private __gap;

    // ──────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────

    event ClaimSubmitted(
        uint256 indexed claimId,
        uint256 indexed policyId,
        address indexed claimant,
        bytes32 merkleRoot,
        uint256 amount,
        uint256 timestamp
    );
    event ClaimStatusChanged(uint256 indexed claimId, ClaimStatus status);
    event ClaimPayout(uint256 indexed claimId, address indexed to, uint256 amount, address token);
    event RateLimitsUpdated(uint256 maxPerClaim, uint256 maxPerWindow, uint256 windowSeconds);
    event ForeignTokenRescued(address indexed token, address indexed to, uint256 amount);
    event StuckPayoutReleased(uint256 indexed claimId, address indexed to, uint256 amount);
    event PolicyRegistryUpdated(address newPolicyRegistry);

    // ──────────────────────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────────────────────

    error ClaimNotFound();
    error ClaimNotApproved();
    error ClaimAmountExceedsCap();
    error RateLimitWindowExceeded();
    error OracleRequestAlreadyUsed();
    error CannotRescuePayoutToken();
    error PayoutHasNotFailed();
    error PolicyRegistryNotSet();
    error PolicyNotActive();
    error NotPolicyHolder();
    error ClaimExceedsPolicyCoverage();
    error PremiumNotCurrent();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ──────────────────────────────────────────────────────────────
    // Initializer (replaces constructor for upgradeable pattern)
    // ──────────────────────────────────────────────────────────────

    function initialize(
        address timelockAdmin,
        address payoutTokenAddress,
        address policyRegistryAddress,
        uint256 maxPayoutPerClaim_,
        uint256 maxPayoutPerWindow_,
        uint256 rateLimitWindowSeconds_
    ) external initializer {
        // v5 note: __AccessControl_init()/__Pausable_init()/
        // __UUPSUpgradeable_init() no longer exist — confirmed empty
        // no-ops as of v5.0.1, and removed entirely by a later v5.x
        // release (a real forge build reported __UUPSUpgradeable_init
        // as an undeclared identifier). Removing all three calls is
        // behaviorally identical to calling them, since they never did
        // anything — not skipped initialization, just a dead call.
        // No __ReentrancyGuard_init() — v5's plain ReentrancyGuard needs
        // no initializer; see the import comment above for why.

        _grantRole(DEFAULT_ADMIN_ROLE, timelockAdmin);
        _grantRole(ADMIN_ROLE, timelockAdmin);
        _grantRole(UPGRADER_ROLE, timelockAdmin);

        payoutToken = IERC20(payoutTokenAddress);
        policyRegistry = policyRegistryAddress;
        nextClaimId = 1;

        maxPayoutPerClaim = maxPayoutPerClaim_;
        maxPayoutPerWindow = maxPayoutPerWindow_;
        rateLimitWindowSeconds = rateLimitWindowSeconds_;
        _windowStart = block.timestamp;
    }

    // ──────────────────────────────────────────────────────────────
    // Claim lifecycle
    // ──────────────────────────────────────────────────────────────

    /// @notice Validates the claim against InsurancePolicy before accepting
    ///         it: the policy must exist and be active, msg.sender must be
    ///         the actual policyholder, and this claim's amount plus every
    ///         prior *non-rejected* claim on the same policy must not
    ///         exceed the policy's total coverage.
    /// @dev Design decision on cumulative consumption (previously left
    ///      open): ClaimRegistry computes consumption itself by summing
    ///      its own `policyClaims[policyId]` records rather than asking
    ///      InsurancePolicy to track "remaining coverage." Rationale:
    ///      claim amounts and statuses already live here, so this avoids
    ///      InsurancePolicy needing a privileged callback path from
    ///      ClaimRegistry (which would mean two contracts maintaining
    ///      overlapping mutable state that could drift out of sync).
    ///      Trade-off: `_consumedCoverage` costs gas proportional to the
    ///      number of prior claims on the policy, since it loops over
    ///      `policyClaims[policyId]`. Acceptable at expected claim volumes
    ///      for this project's scale; if a single policy could realistically
    ///      accumulate hundreds of claims, this should be revisited (e.g. a
    ///      running counter decremented only on Rejected, accepting the
    ///      cross-contract-state trade-off this design avoided here).
    function submitClaim(uint256 policyId, bytes32 merkleRoot, uint256 amount)
        external
        whenNotPaused
        returns (uint256 claimId)
    {
        if (amount > maxPayoutPerClaim) revert ClaimAmountExceedsCap();
        if (policyRegistry == address(0)) revert PolicyRegistryNotSet();

        // STATICCALL under the hood (external `view` interface call) —
        // cannot modify state, so this introduces no reentrancy surface.
        IInsurancePolicyRegistry.Policy memory p =
            IInsurancePolicyRegistry(policyRegistry).getPolicy(policyId);

        if (p.revoked || block.timestamp < p.validFrom || block.timestamp > p.validUntil) {
            revert PolicyNotActive();
        }
        if (p.holder != msg.sender) revert NotPolicyHolder();

        if (!IInsurancePolicyRegistry(policyRegistry).isPremiumCurrent(policyId)) {
            revert PremiumNotCurrent();
        }

        uint256 consumedSoFar = _consumedCoverage(policyId);
        if (consumedSoFar + amount > p.coverageAmount) revert ClaimExceedsPolicyCoverage();

        claimId = nextClaimId++;
        claims[claimId] = Claim({
            claimId: uint128(claimId),
            policyId: uint128(policyId),
            claimant: msg.sender,
            amount: uint96(amount),
            status: ClaimStatus.Submitted,
            submittedAt: uint40(block.timestamp),
            processedAt: 0,
            merkleRoot: merkleRoot
        });
        policyClaims[policyId].push(claimId);

        emit ClaimSubmitted(claimId, policyId, msg.sender, merkleRoot, amount, block.timestamp);
    }

    /// @dev Sums the amount of every claim on `policyId` that is not
    ///      Rejected — i.e. a pending (Submitted/UnderReview), Approved, or
    ///      already-Paid claim all continue to reserve coverage capacity.
    ///      This is a deliberate business rule: it prevents a policyholder
    ///      from submitting claims that collectively exceed coverage while
    ///      earlier claims on the same policy are still unresolved, rather
    ///      than only checking against currently-Paid claims.
    function _consumedCoverage(uint256 policyId) private view returns (uint256 total) {
        uint256[] storage ids = policyClaims[policyId];
        uint256 len = ids.length;
        for (uint256 i = 0; i < len; i++) {
            Claim storage c = claims[ids[i]];
            if (c.status != ClaimStatus.Rejected) {
                total += c.amount;
            }
        }
    }

    /// @notice Underwriter-role status transition. Oracle-role callers use
    ///         `recordOracleVerification` instead, which additionally
    ///         enforces oracle-response replay protection.
    function setClaimStatus(uint256 claimId, ClaimStatus status)
        external
        whenNotPaused
        onlyRole(UNDERWRITER_ROLE)
    {
        Claim storage c = claims[claimId];
        if (c.claimant == address(0)) revert ClaimNotFound();

        c.status = status;
        if (status == ClaimStatus.Approved || status == ClaimStatus.Rejected) {
            c.processedAt = uint40(block.timestamp);
        }
        emit ClaimStatusChanged(claimId, status);
    }

    /// @notice Oracle-attested verification, bound to a specific claim and
    ///         a specific request ID to prevent replay of a prior response.
    function recordOracleVerification(uint256 claimId, bytes32 requestId, bool approved)
        external
        whenNotPaused
        onlyRole(ORACLE_ROLE)
    {
        if (usedOracleRequestIds[requestId]) revert OracleRequestAlreadyUsed();
        usedOracleRequestIds[requestId] = true;

        Claim storage c = claims[claimId];
        if (c.claimant == address(0)) revert ClaimNotFound();

        c.status = approved ? ClaimStatus.Approved : ClaimStatus.Rejected;
        c.processedAt = uint40(block.timestamp);
        emit ClaimStatusChanged(claimId, c.status);
    }

    function payoutClaim(uint256 claimId)
        external
        whenNotPaused
        nonReentrant
        onlyRole(UNDERWRITER_ROLE)
    {
        Claim storage c = claims[claimId];
        if (c.claimant == address(0)) revert ClaimNotFound();
        if (c.status != ClaimStatus.Approved) revert ClaimNotApproved();

        _enforceRateLimit(c.amount);

        c.status = ClaimStatus.Paid;
        c.processedAt = uint40(block.timestamp);

        payoutToken.safeTransfer(c.claimant, c.amount);

        emit ClaimPayout(claimId, c.claimant, c.amount, address(payoutToken));
    }

    function _enforceRateLimit(uint256 amount) private {
        if (block.timestamp >= _windowStart + rateLimitWindowSeconds) {
            _windowStart = block.timestamp;
            _windowTotalPaid = 0;
        }
        if (_windowTotalPaid + amount > maxPayoutPerWindow) revert RateLimitWindowExceeded();
        _windowTotalPaid += amount;
    }

    // ──────────────────────────────────────────────────────────────
    // Emergency controls
    // ──────────────────────────────────────────────────────────────

    /// @notice Fast, single-role emergency brake. No timelock delay by
    ///         design — a pause must be immediate to be useful.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Deliberately gated behind ADMIN_ROLE (the timelock), not
    ///         PAUSER_ROLE — resuming operation warrants more scrutiny
    ///         than halting it.
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    function updateRateLimits(
        uint256 maxPerClaim,
        uint256 maxPerWindow,
        uint256 windowSeconds
    ) external onlyRole(ADMIN_ROLE) {
        maxPayoutPerClaim = maxPerClaim;
        maxPayoutPerWindow = maxPerWindow;
        rateLimitWindowSeconds = windowSeconds;
        emit RateLimitsUpdated(maxPerClaim, maxPerWindow, windowSeconds);
    }

    /// @notice Allows repointing to a new InsurancePolicy deployment (e.g.
    ///         after an InsurancePolicy upgrade that changes its address —
    ///         which shouldn't happen under UUPS since the proxy address
    ///         is stable across upgrades, but this exists for the case of
    ///         a full migration to a newly deployed registry). Behind
    ///         ADMIN_ROLE, i.e. the timelock.
    function setPolicyRegistry(address newPolicyRegistry) external onlyRole(ADMIN_ROLE) {
        policyRegistry = newPolicyRegistry;
        emit PolicyRegistryUpdated(newPolicyRegistry);
    }

    // ──────────────────────────────────────────────────────────────
    // Stuck-fund recovery — deliberately split into two narrow functions.
    // See design notes: neither accepts an arbitrary free-form recipient
    // for the payout token itself.
    // ──────────────────────────────────────────────────────────────

    /// @notice Recovers ERC-20 tokens accidentally sent to this contract.
    ///         Explicitly cannot be used on the payout token — that path
    ///         is `releaseStuckPayout` below, which is claim-scoped.
    function rescueForeignToken(address token, address to, uint256 amount)
        external
        onlyRole(ADMIN_ROLE)
    {
        if (token == address(payoutToken)) revert CannotRescuePayoutToken();
        IERC20(token).safeTransfer(to, amount);
        emit ForeignTokenRescued(token, to, amount);
    }

    /// @notice Releases a payout that is Approved but failed to transfer on
    ///         a prior `payoutClaim` attempt (e.g., claimant address cannot
    ///         receive tokens). Recipient is always the claim's own
    ///         claimant address — never a caller-supplied address — so this
    ///         function cannot be used to redirect funds anywhere else.
    function releaseStuckPayout(uint256 claimId) external nonReentrant onlyRole(ADMIN_ROLE) {
        Claim storage c = claims[claimId];
        if (c.claimant == address(0)) revert ClaimNotFound();
        if (c.status != ClaimStatus.Approved) revert PayoutHasNotFailed();

        c.status = ClaimStatus.Paid;
        c.processedAt = uint40(block.timestamp);

        payoutToken.safeTransfer(c.claimant, c.amount);

        emit StuckPayoutReleased(claimId, c.claimant, c.amount);
    }

    // ──────────────────────────────────────────────────────────────
    // Views
    // ──────────────────────────────────────────────────────────────

    function getClaimsForPolicy(uint256 policyId) external view returns (uint256[] memory) {
        return policyClaims[policyId];
    }

    function currentWindowUsage() external view returns (uint256 windowStart, uint256 totalPaid) {
        return (_windowStart, _windowTotalPaid);
    }

    // ──────────────────────────────────────────────────────────────
    // UUPS authorization hook
    // ──────────────────────────────────────────────────────────────

    /// @dev Only an address holding UPGRADER_ROLE (expected: the
    ///      TimelockController) may authorize an upgrade. Because it's
    ///      behind the timelock, every upgrade is queued and publicly
    ///      visible for the configured delay before it can execute.
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}
