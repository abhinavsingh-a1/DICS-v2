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
import "./StableCoin.sol";
import "./PriceOracle.sol";

/// @title Vault — single-collateral, demo-scope CDP
/// @notice SCOPE DISCLOSURE (read before assuming this is production-
///         grade): this is a deliberately simplified, single-collateral
///         version of the multi-collateral system originally discussed.
///         Liquidation logic — a separate `Liquidator.sol` contract in
///         the original sketch — is folded directly into this contract
///         to reduce the number of moving pieces for a demo; a real
///         multi-collateral production system would likely want
///         liquidation as a separate, replaceable module. Risk
///         parameters (`minCollateralRatioBps`, `liquidationPenaltyBps`)
///         live as plain state here rather than in a dedicated
///         `GovernanceParams` contract, for the same reason — they are
///         still governance-gated (see DICSGovernor.sol), just not
///         factored into their own contract.
/// @dev The single biggest real risk in this design is `priceOracle` —
///      see PriceOracle.sol's own header. Everything downstream of a
///      price read (collateral ratio checks, liquidation eligibility)
///      is only as trustworthy as that price.
contract Vault is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct Position {
        uint256 collateralAmount;
        uint256 debtAmount;
    }

    IERC20 public collateralToken;
    StableCoin public stableCoin;
    PriceOracle public priceOracle;

    /// @dev Basis points (10_000 = 100%). 15_000 means 150% minimum
    ///      collateralization — governance-adjustable, per the original
    ///      "governance controls collateralization ratios" requirement.
    uint256 public minCollateralRatioBps;
    uint256 public liquidationPenaltyBps;

    mapping(address => Position) public positions;

    bool private _stableCoinSet;

    uint256[41] private __gap;

    event CollateralDeposited(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event DebtMinted(address indexed user, uint256 amount);
    event DebtRepaid(address indexed user, uint256 amount);
    event PositionLiquidated(
        address indexed user,
        address indexed liquidator,
        uint256 debtCovered,
        uint256 collateralSeized
    );
    event RiskParamsUpdated(uint256 minCollateralRatioBps, uint256 liquidationPenaltyBps);
    event StableCoinSet(address stableCoin);

    error StableCoinAlreadySet();
    error StableCoinNotSet();
    error BelowMinCollateralRatio();
    error InsufficientCollateral();
    error InsufficientDebt();
    error PositionNotLiquidatable();
    error ZeroAmount();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address timelockAdmin,
        address collateralTokenAddress,
        address priceOracleAddress,
        uint256 minCollateralRatioBps_,
        uint256 liquidationPenaltyBps_
    ) external initializer {
        // v5 note: __AccessControl_init()/__Pausable_init()/
        // __UUPSUpgradeable_init() no longer exist — confirmed empty
        // no-ops as of v5.0.1, and removed entirely by a later v5.x
        // release (a real forge build reported __UUPSUpgradeable_init
        // as an undeclared identifier). Removing all three calls is
        // behaviorally identical to calling them, since they never did
        // anything — not skipped initialization, just a dead call.
        // No __ReentrancyGuard_init() needed for v5's plain ReentrancyGuard.

        _grantRole(DEFAULT_ADMIN_ROLE, timelockAdmin);
        _grantRole(ADMIN_ROLE, timelockAdmin);
        _grantRole(UPGRADER_ROLE, timelockAdmin);

        collateralToken = IERC20(collateralTokenAddress);
        priceOracle = PriceOracle(priceOracleAddress);
        minCollateralRatioBps = minCollateralRatioBps_;
        liquidationPenaltyBps = liquidationPenaltyBps_;
    }

    /// @notice Bootstrapping step resolving the Vault/StableCoin circular
    ///         dependency — see StableCoin.sol's own comment on the same
    ///         issue from its side. One-time only.
    function setStableCoin(address stableCoinAddress) external onlyRole(ADMIN_ROLE) {
        if (_stableCoinSet) revert StableCoinAlreadySet();
        stableCoin = StableCoin(stableCoinAddress);
        _stableCoinSet = true;
        emit StableCoinSet(stableCoinAddress);
    }

    // ──────────────────────────────────────────────────────────────
    // Core CDP operations
    // ──────────────────────────────────────────────────────────────

    function depositCollateral(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        positions[msg.sender].collateralAmount += amount;
        emit CollateralDeposited(msg.sender, amount);
    }

    function withdrawCollateral(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Position storage p = positions[msg.sender];
        if (p.collateralAmount < amount) revert InsufficientCollateral();

        uint256 remaining = p.collateralAmount - amount;
        if (p.debtAmount > 0 && !_meetsMinRatio(remaining, p.debtAmount)) {
            revert BelowMinCollateralRatio();
        }

        p.collateralAmount = remaining;
        collateralToken.safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    function mintStableCoin(uint256 amount) external whenNotPaused nonReentrant {
        if (!_stableCoinSet) revert StableCoinNotSet();
        if (amount == 0) revert ZeroAmount();

        Position storage p = positions[msg.sender];
        uint256 newDebt = p.debtAmount + amount;
        if (!_meetsMinRatio(p.collateralAmount, newDebt)) revert BelowMinCollateralRatio();

        p.debtAmount = newDebt;
        stableCoin.mint(msg.sender, amount);
        emit DebtMinted(msg.sender, amount);
    }

    function repayDebt(uint256 amount) external whenNotPaused nonReentrant {
        if (!_stableCoinSet) revert StableCoinNotSet();
        if (amount == 0) revert ZeroAmount();

        Position storage p = positions[msg.sender];
        if (p.debtAmount < amount) revert InsufficientDebt();

        p.debtAmount -= amount;
        stableCoin.burn(msg.sender, amount);
        emit DebtRepaid(msg.sender, amount);
    }

    // ──────────────────────────────────────────────────────────────
    // Liquidation
    // ──────────────────────────────────────────────────────────────

    /// @notice Permissionless — anyone holding enough dUSD to cover
    ///         `debtToCover` may liquidate an undercollateralized
    ///         position and receive the seized collateral (principal +
    ///         penalty) at a discount to its oracle-priced value.
    function liquidate(address user, uint256 debtToCover)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 collateralSeized)
    {
        if (!_stableCoinSet) revert StableCoinNotSet();
        Position storage p = positions[user];

        if (_meetsMinRatio(p.collateralAmount, p.debtAmount)) revert PositionNotLiquidatable();
        if (debtToCover > p.debtAmount) revert InsufficientDebt();

        // Collateral seized = value of the covered debt, plus the
        // liquidation penalty, converted to collateral-token units at
        // the current oracle price.
        uint256 price = priceOracle.getPrice();
        uint256 debtValueInCollateral = (debtToCover * 1e18) / price;
        collateralSeized = debtValueInCollateral + (debtValueInCollateral * liquidationPenaltyBps) / 10_000;
        if (collateralSeized > p.collateralAmount) {
            collateralSeized = p.collateralAmount; // cap — never seize more than the position holds
        }

        p.debtAmount -= debtToCover;
        p.collateralAmount -= collateralSeized;

        // Burns the LIQUIDATOR's dUSD (msg.sender here, not `user`) to
        // actually pay off the covered debt — this is the real economic
        // action that makes liquidation solvency-preserving: bad debt is
        // extinguished by dUSD that genuinely leaves circulation.
        stableCoin.burn(msg.sender, debtToCover);
        collateralToken.safeTransfer(msg.sender, collateralSeized);

        emit PositionLiquidated(user, msg.sender, debtToCover, collateralSeized);
    }

    // ──────────────────────────────────────────────────────────────
    // Views
    // ──────────────────────────────────────────────────────────────

    function _meetsMinRatio(uint256 collateralAmount, uint256 debtAmount) private view returns (bool) {
        if (debtAmount == 0) return true;
        uint256 price = priceOracle.getPrice();
        uint256 collateralValueUsd = (collateralAmount * price) / 1e18;
        uint256 ratioBps = (collateralValueUsd * 10_000) / debtAmount;
        return ratioBps >= minCollateralRatioBps;
    }

    function currentCollateralRatioBps(address user) external view returns (uint256) {
        Position storage p = positions[user];
        if (p.debtAmount == 0) return type(uint256).max;
        uint256 price = priceOracle.getPrice();
        uint256 collateralValueUsd = (p.collateralAmount * price) / 1e18;
        return (collateralValueUsd * 10_000) / p.debtAmount;
    }

    function isLiquidatable(address user) external view returns (bool) {
        Position storage p = positions[user];
        return !_meetsMinRatio(p.collateralAmount, p.debtAmount);
    }

    // ──────────────────────────────────────────────────────────────
    // Governance-gated parameter updates and emergency controls
    // ──────────────────────────────────────────────────────────────

    /// @dev Expected caller: DICSGovernor.sol, via its own dedicated
    ///      TimelockController — see the governance module's deployment
    ///      notes. Deliberately a different Timelock instance than the
    ///      one controlling ClaimRegistry/InsurancePolicy/OracleAdapter,
    ///      keeping the CDP module's governance domain separate from the
    ///      claims system's.
    function updateRiskParams(uint256 newMinCollateralRatioBps, uint256 newLiquidationPenaltyBps)
        external
        onlyRole(ADMIN_ROLE)
    {
        minCollateralRatioBps = newMinCollateralRatioBps;
        liquidationPenaltyBps = newLiquidationPenaltyBps;
        emit RiskParamsUpdated(newMinCollateralRatioBps, newLiquidationPenaltyBps);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
