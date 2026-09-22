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
