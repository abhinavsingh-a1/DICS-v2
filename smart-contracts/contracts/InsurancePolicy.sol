// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
// v5 note: ReentrancyGuardUpgradeable no longer exists — see
// ClaimRegistry.sol's import comment for the full explanation.
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title InsurancePolicy (UUPS upgradeable)
/// @notice Registry of insurance policies, PLUS premium collection.
///         ClaimRegistry calls `isPremiumCurrent` (added alongside this
///         premium module) before accepting a claim — a policy that has
///         lapsed cannot be claimed against, the same way a real policy
///         works.
/// @dev Same role/upgrade pattern as ClaimRegistry: ADMIN_ROLE and
///      UPGRADER_ROLE are expected to be held by a TimelockController.
///      PREMIUM CURRENCY DECISION: `premiumToken` is intended to be the
///      CDP module's StableCoin (dUSD) — see Vault.sol. This is a loose,
///      ERC-20-level coupling only: InsurancePolicy just calls
///      `safeTransferFrom` like it would for any token, with no minting
///      privilege and no dependency on the CDP Timelock. The two
///      governance domains stay exactly as separate as documented
///      elsewhere; only the token itself is shared. The real UX cost
///      this creates — a policyholder needs to already hold dUSD, which
///      today means opening a CDP position or receiving it from someone
///      else — is a genuine gap, not hidden here.
contract InsurancePolicy is
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

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @dev Intended holder: business-operations Safe (underwriting ops),
    ///      distinct from the claims UNDERWRITER_ROLE on ClaimRegistry —
    ///      registering a policy and approving a claim against it should
    ///      never require the same signer set.
    bytes32 public constant POLICY_MANAGER_ROLE = keccak256("POLICY_MANAGER_ROLE");

    // ──────────────────────────────────────────────────────────────
    // Types
    // ──────────────────────────────────────────────────────────────

    struct Policy {
        uint128 policyId;
        uint128 coverageAmount;
        address holder;
        uint40 validFrom;
        uint40 validUntil;
        bool revoked;
        bytes32 metadataHash; // e.g. hash of off-chain policy document
    }

    struct PremiumTerms {
        uint128 amountPerPeriod;
        uint40 periodSeconds;
    }

    /// @notice A self-service policy type a user can subscribe to
    ///         directly — the "pick a plan" catalog entry. Populated by
    ///         POLICY_MANAGER_ROLE, then browsable/subscribable by
    ///         anyone. `active` lets a plan be discontinued for new
    ///         subscribers without touching policies already issued from
    ///         it — the same real-world pattern as an insurer retiring a
    ///         product tier.
    struct PolicyTemplate {
        uint128 coverageAmount;
        uint128 premiumAmountPerPeriod;
        uint40 periodSeconds;
        uint40 termSeconds;
        bool active;
        bytes32 metadataHash;
    }

    // ──────────────────────────────────────────────────────────────
    // Storage
    // ──────────────────────────────────────────────────────────────

    mapping(uint256 => Policy) private _policies;
    mapping(uint256 => bool) private _exists;

    IERC20 public premiumToken;
    address public premiumTreasury;
    uint256 public premiumGracePeriodSeconds;
    mapping(uint256 => PremiumTerms) public premiumTerms;
    mapping(uint256 => uint256) public premiumPaidUntil;

    mapping(uint256 => PolicyTemplate) public policyTemplates;
    uint256 public nextPolicyId;

    // Slot history: started at 47. Premium module (token, treasury,
    // grace period, 2 mappings) used 5, leaving 42. This catalog module
    // (policyTemplates mapping, nextPolicyId) uses 2 more, leaving 40.
    uint256[40] private __gap;

    // ──────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────

    event PolicyRegistered(
        uint256 indexed policyId,
        address indexed holder,
        uint256 validFrom,
        uint256 validUntil,
        uint256 coverageAmount,
        bytes32 metadataHash
    );
    event PolicyRevoked(uint256 indexed policyId);
    event PolicyCoverageUpdated(uint256 indexed policyId, uint256 newCoverageAmount);
    event PremiumConfigUpdated(address token, address treasury, uint256 gracePeriodSeconds);
    event PremiumTermsSet(uint256 indexed policyId, uint256 amountPerPeriod, uint256 periodSeconds);
    event PremiumPaid(uint256 indexed policyId, address indexed payer, uint256 amount, uint256 paidUntil);
    event PolicyTemplateAdded(
        uint256 indexed templateId,
        uint256 coverageAmount,
        uint256 premiumAmountPerPeriod,
        uint256 periodSeconds,
        uint256 termSeconds
    );
    event PolicyTemplateStatusChanged(uint256 indexed templateId, bool active);
    event PolicySubscribed(
        uint256 indexed policyId, uint256 indexed templateId, address indexed holder, uint256 validUntil
    );

    // ──────────────────────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────────────────────

    error PolicyAlreadyExists();
    error PolicyNotFound();
    error InvalidHolder();
    error InvalidDateRange();
    error PremiumTokenNotSet();
    error PremiumTermsNotSet();
    error OnlyPolicyHolderCanPay();
    error PolicyTemplateNotFound();
    error PolicyTemplateInactive();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address timelockAdmin) external initializer {
        // v5 correction: an earlier pass removed __AccessControl_init()
        // and __Pausable_init() here based on a forum post claiming both
        // were empty no-ops in v5.0.1 — but that was never independently
        // confirmed the way __UUPSUpgradeable_init()'s removal was (that
        // one has a real "Undeclared identifier" compiler error behind
        // it). OpenZeppelin's actual current source
        // (AccessControlUpgradeable.sol on GitHub) shows __AccessControl_init()
        // still exists as a real function — restored here, along with
        // __Pausable_init() for the same reason (same weaker-evidence
        // category, not independently disproven either way). Only
        // __UUPSUpgradeable_init() stays removed, since that's the one
        // change with direct compiler proof behind it.
        __AccessControl_init();
        __Pausable_init();
        // No __ReentrancyGuard_init() needed for v5's plain ReentrancyGuard.

        _grantRole(DEFAULT_ADMIN_ROLE, timelockAdmin);
        _grantRole(ADMIN_ROLE, timelockAdmin);
        _grantRole(UPGRADER_ROLE, timelockAdmin);

        nextPolicyId = 1;
    }

    // ──────────────────────────────────────────────────────────────
    // Premium configuration and collection
    // ──────────────────────────────────────────────────────────────

    /// @notice Sets which token premiums are paid in, where they go, and
    ///         how much grace a lapsed policy gets before claims are
    ///         blocked. Intended `token`: the CDP module's StableCoin
    ///         (dUSD) proxy address — see this contract's header.
    function setPremiumConfig(address token, address treasury, uint256 gracePeriodSeconds)
        external
        onlyRole(ADMIN_ROLE)
    {
        premiumToken = IERC20(token);
        premiumTreasury = treasury;
        premiumGracePeriodSeconds = gracePeriodSeconds;
        emit PremiumConfigUpdated(token, treasury, gracePeriodSeconds);
    }

    /// @notice Sets the recurring premium amount and billing period for
    ///         one policy. Business-ops decision (pricing), so gated by
    ///         POLICY_MANAGER_ROLE, same as registerPolicy itself.
    function setPremiumTerms(uint256 policyId, uint256 amountPerPeriod, uint256 periodSeconds)
        external
        onlyRole(POLICY_MANAGER_ROLE)
    {
        if (!_exists[policyId]) revert PolicyNotFound();
        premiumTerms[policyId] = PremiumTerms({
            amountPerPeriod: uint128(amountPerPeriod),
            periodSeconds: uint40(periodSeconds)
        });
        emit PremiumTermsSet(policyId, amountPerPeriod, periodSeconds);
    }

    /// @notice The policyholder-facing function — pays one period's
    ///         premium in `premiumToken`, extending `premiumPaidUntil`.
    ///         Payment always extends from whichever is LATER: the
    ///         current paid-until date, or now — paying early never
    ///         wastes the remainder of an already-paid period, and
    ///         paying after a lapse doesn't backdate coverage.
    function payPremium(uint256 policyId) external whenNotPaused nonReentrant {
        if (!_exists[policyId]) revert PolicyNotFound();
        if (_policies[policyId].holder != msg.sender) revert OnlyPolicyHolderCanPay();
        _collectPremium(policyId, msg.sender);
    }

    /// @dev Shared by payPremium (renewal) and subscribeToPolicy (first
    ///      payment, collected atomically with issuance). Factored out
    ///      specifically so subscribeToPolicy's mandatory first payment
    ///      and payPremium's renewal payment can never drift out of sync
    ///      with each other — one implementation of "what a premium
    ///      payment does," not two.
    function _collectPremium(uint256 policyId, address payer) private {
        if (address(premiumToken) == address(0)) revert PremiumTokenNotSet();
        PremiumTerms memory terms = premiumTerms[policyId];
        if (terms.amountPerPeriod == 0) revert PremiumTermsNotSet();

        uint256 base = premiumPaidUntil[policyId] > block.timestamp
            ? premiumPaidUntil[policyId]
            : block.timestamp;
        uint256 newPaidUntil = base + terms.periodSeconds;
        premiumPaidUntil[policyId] = newPaidUntil;

        premiumToken.safeTransferFrom(payer, premiumTreasury, terms.amountPerPeriod);

        emit PremiumPaid(policyId, payer, terms.amountPerPeriod, newPaidUntil);
    }

    /// @notice True if the policy's premium is paid through today, or
    ///         still within the post-lapse grace period. This is what
    ///         ClaimRegistry checks before accepting a claim — see
    ///         ClaimRegistry.sol's `submitClaim`.
    /// @dev A policy with no premium terms ever configured
    ///      (`premiumTerms[policyId].amountPerPeriod == 0`) is treated
    ///      as premium-exempt (returns true) rather than permanently
    ///      unclaimable — premium billing is opt-in per policy, not a
    ///      universal requirement this contract forces on every caller.
    function isPremiumCurrent(uint256 policyId) public view returns (bool) {
        if (premiumTerms[policyId].amountPerPeriod == 0) return true;
        return block.timestamp <= premiumPaidUntil[policyId] + premiumGracePeriodSeconds;
    }

    // ──────────────────────────────────────────────────────────────
    // Policy catalog — self-service issuance
    // ──────────────────────────────────────────────────────────────

    /// @notice Adds a subscribable plan to the catalog. Business-ops
    ///         decision (what products exist, at what price), so gated
    ///         the same as registerPolicy/setPremiumTerms.
    function addPolicyTemplate(
        uint256 templateId,
        uint256 coverageAmount,
        uint256 premiumAmountPerPeriod,
        uint256 periodSeconds,
        uint256 termSeconds,
        bytes32 metadataHash
    ) external whenNotPaused onlyRole(POLICY_MANAGER_ROLE) {
        policyTemplates[templateId] = PolicyTemplate({
            coverageAmount: uint128(coverageAmount),
            premiumAmountPerPeriod: uint128(premiumAmountPerPeriod),
            periodSeconds: uint40(periodSeconds),
            termSeconds: uint40(termSeconds),
            active: true,
            metadataHash: metadataHash
        });
        emit PolicyTemplateAdded(templateId, coverageAmount, premiumAmountPerPeriod, periodSeconds, termSeconds);
    }

    /// @notice Discontinues (or re-enables) a plan for NEW subscribers.
    ///         Existing policies already issued from this template are
    ///         entirely unaffected — same as a real insurer retiring a
    ///         product tier without cancelling current customers.
    function setPolicyTemplateActive(uint256 templateId, bool active) external onlyRole(POLICY_MANAGER_ROLE) {
        if (policyTemplates[templateId].premiumAmountPerPeriod == 0) revert PolicyTemplateNotFound();
        policyTemplates[templateId].active = active;
        emit PolicyTemplateStatusChanged(templateId, active);
    }

    /// @notice THE self-service entry point: pick a plan, pay for it,
    ///         walk away with an active policy — all in one transaction.
    ///         This is what makes "system checks validity, then premium
    ///         moves, then coverage exists" a single atomic step instead
    ///         of a multi-stage process a user could get stuck halfway
    ///         through. Requires the caller to have already approved
    ///         this contract to pull `premiumAmountPerPeriod` of
    ///         `premiumToken` — the same wallet-approval step any
    ///         real-world "pay with card" checkout has an equivalent of.
    function subscribeToPolicy(uint256 templateId) external whenNotPaused nonReentrant returns (uint256 policyId) {
        PolicyTemplate memory template = policyTemplates[templateId];
        if (template.premiumAmountPerPeriod == 0) revert PolicyTemplateNotFound();
        if (!template.active) revert PolicyTemplateInactive();

        policyId = nextPolicyId;
        // Defensive skip-forward in case an admin separately used
        // registerPolicy with an ID that collides with the counter —
        // bounded, since admin-registered IDs are sparse in practice;
        // documented rather than assumed impossible.
        uint256 attempts;
        while (_exists[policyId]) {
            policyId++;
            attempts++;
            require(attempts < 1000, "policy id space exhausted");
        }
        nextPolicyId = policyId + 1;

        uint256 validUntil = block.timestamp + template.termSeconds;

        _policies[policyId] = Policy({
            policyId: uint128(policyId),
            coverageAmount: template.coverageAmount,
            holder: msg.sender,
            validFrom: uint40(block.timestamp),
            validUntil: uint40(validUntil),
            revoked: false,
            metadataHash: template.metadataHash
        });
        _exists[policyId] = true;

        premiumTerms[policyId] =
            PremiumTerms({amountPerPeriod: template.premiumAmountPerPeriod, periodSeconds: template.periodSeconds});

        emit PolicyRegistered(
            policyId, msg.sender, block.timestamp, validUntil, template.coverageAmount, template.metadataHash
        );
        emit PolicySubscribed(policyId, templateId, msg.sender, validUntil);

        // Mandatory first payment, collected in the SAME transaction as
        // issuance — this is the actual fix for "a policy could exist
        // with premium terms set but premiumPaidUntil still at zero."
        // A subscribeToPolicy call either fully succeeds (policy exists
        // AND is paid through one period) or fully reverts (nothing
        // exists at all) — never a half-issued, unpaid policy.
        _collectPremium(policyId, msg.sender);
    }

    // ──────────────────────────────────────────────────────────────
    // Policy management
    // ──────────────────────────────────────────────────────────────

    function registerPolicy(
        uint256 policyId,
        address holder,
        uint256 validFrom,
        uint256 validUntil,
        uint256 coverageAmount,
        bytes32 metadataHash
    ) external whenNotPaused onlyRole(POLICY_MANAGER_ROLE) {
        if (_exists[policyId]) revert PolicyAlreadyExists();
        if (holder == address(0)) revert InvalidHolder();
        if (validUntil <= validFrom) revert InvalidDateRange();

        _policies[policyId] = Policy({
            policyId: uint128(policyId),
            coverageAmount: uint128(coverageAmount),
            holder: holder,
            validFrom: uint40(validFrom),
            validUntil: uint40(validUntil),
            revoked: false,
            metadataHash: metadataHash
        });
        _exists[policyId] = true;

        emit PolicyRegistered(policyId, holder, validFrom, validUntil, coverageAmount, metadataHash);
    }

    function revokePolicy(uint256 policyId) external whenNotPaused onlyRole(POLICY_MANAGER_ROLE) {
        if (!_exists[policyId]) revert PolicyNotFound();
        _policies[policyId].revoked = true;
        emit PolicyRevoked(policyId);
    }

    function updateCoverage(uint256 policyId, uint256 newCoverageAmount)
        external
        whenNotPaused
        onlyRole(POLICY_MANAGER_ROLE)
    {
        if (!_exists[policyId]) revert PolicyNotFound();
        _policies[policyId].coverageAmount = uint128(newCoverageAmount);
        emit PolicyCoverageUpdated(policyId, newCoverageAmount);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    // ──────────────────────────────────────────────────────────────
    // Views — this is the surface ClaimRegistry should call
    // ──────────────────────────────────────────────────────────────

    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        if (!_exists[policyId]) revert PolicyNotFound();
        return _policies[policyId];
    }

    function isPolicyActive(uint256 policyId, uint256 atTime) public view returns (bool) {
        if (!_exists[policyId]) return false;
        Policy storage p = _policies[policyId];
        if (p.revoked) return false;
        return atTime >= p.validFrom && atTime <= p.validUntil;
    }

    /// @notice Single call ClaimRegistry.submitClaim should use to validate
    ///         a claim before accepting it: policy must be active, the
    ///         submitting address must be the policy holder, and the
    ///         claimed amount must not exceed remaining coverage.
    /// @dev Currently a pure view helper — does not mutate state, so it
    ///      does not track "coverage consumed so far" across multiple
    ///      claims on the same policy. That's a deliberate scope
    ///      boundary, not an oversight: tracking cumulative consumption
    ///      requires this contract to know about claim outcomes (paid vs.
    ///      rejected), which means either ClaimRegistry calling back into
    ///      here on payout, or this contract reading ClaimRegistry state.
    ///      Left as an explicit next step rather than guessed at here.
    function isClaimEligible(uint256 policyId, address claimant, uint256 claimAmount, uint256 atTime)
        external
        view
        returns (bool eligible)
    {
        if (!_exists[policyId]) return false;
        Policy storage p = _policies[policyId];
        if (p.revoked) return false;
        if (p.holder != claimant) return false;
        if (atTime < p.validFrom || atTime > p.validUntil) return false;
        if (claimAmount > p.coverageAmount) return false;
        if (!isPremiumCurrent(policyId)) return false;
        return true;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}
