// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

/// @title PriceOracle — MOCK, admin-controlled USD price feed
/// @notice Explicitly NOT a real oracle — no external data source, no
///         aggregation, no staleness/deviation checks a production feed
///         (e.g. Chainlink) would have. An address holding PRICE_SETTER_ROLE
///         can set the price to anything, at any time. This exists so
///         Vault.sol has something to call; using it for anything beyond
///         demonstrating the CDP mechanics would be a security defect,
///         not a feature — price-oracle manipulation is, by a wide
///         margin, the biggest real risk in any CDP system, and this
///         contract's only job is to make that risk visible and
///         contained (one clearly-labeled mock), not to solve it.
contract PriceOracle is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PRICE_SETTER_ROLE = keccak256("PRICE_SETTER_ROLE");

    /// @dev USD price per 1 whole unit of collateral, scaled by 1e18 —
    ///      e.g. 2_000e18 means "1 collateral token is worth $2,000".
    uint256 public priceScaled;
    uint256 public lastUpdatedAt;

    event PriceUpdated(uint256 newPriceScaled, uint256 timestamp);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address timelockAdmin, uint256 initialPriceScaled) external initializer {
        // v5 note: __AccessControl_init()/__Pausable_init()/
        // __UUPSUpgradeable_init() no longer exist — confirmed empty
        // no-ops as of v5.0.1, and removed entirely by a later v5.x
        // release (a real forge build reported __UUPSUpgradeable_init
        // as an undeclared identifier). Removing all three calls is
        // behaviorally identical to calling them, since they never did
        // anything — not skipped initialization, just a dead call.

        _grantRole(DEFAULT_ADMIN_ROLE, timelockAdmin);
        _grantRole(ADMIN_ROLE, timelockAdmin);
        _grantRole(UPGRADER_ROLE, timelockAdmin);

        priceScaled = initialPriceScaled;
        lastUpdatedAt = block.timestamp;
    }

    function setPrice(uint256 newPriceScaled) external onlyRole(PRICE_SETTER_ROLE) {
        priceScaled = newPriceScaled;
        lastUpdatedAt = block.timestamp;
        emit PriceUpdated(newPriceScaled, block.timestamp);
    }

    function getPrice() external view returns (uint256) {
        return priceScaled;
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
