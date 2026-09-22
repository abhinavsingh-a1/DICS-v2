// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title StableCoin — demo-scope collateral-backed token
/// @notice NOT a production stablecoin. No peg-stability mechanism
///         beyond the overcollateralization + liquidation enforced by
///         Vault.sol. See Vault.sol's own header for the full scope
///         disclosure — this token is the payout/mint side of that
///         disclosure, not a separate claim.
/// @dev Deliberately NOT upgradeable, unlike every other contract in
///      this project. A token contract's non-upgradeability is itself a
///      trust signal for holders (an upgradeable token can have its
///      transfer logic changed after the fact); Vault — which holds all
///      the actual business logic and risk parameters — is upgradeable
///      instead, so evolving the system doesn't require a token
///      migration.
contract StableCoin is ERC20 {
    /// @dev Settable exactly once, post-deployment, by whichever address
    ///      deployed this token — resolves the circular dependency
    ///      between StableCoin and Vault (Vault needs this token's
    ///      address at its own initialize() time; this token can't take
    ///      Vault's address in its constructor if Vault doesn't exist
    ///      yet). One-time-set is not upgradeable-contract-style
    ///      governance; it's a deployment bootstrapping step, done once
    ///      by the deploy script.
    address public vault;
    address public immutable deployer;

    error VaultAlreadySet();
    error OnlyVault();
    error OnlyDeployer();

    constructor() ERC20("DICS Demo USD", "dUSD") {
        deployer = msg.sender;
    }

    function setVault(address vault_) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (vault != address(0)) revert VaultAlreadySet();
        vault = vault_;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    /// @notice Privileged mint — bypasses no allowance, since this isn't
    ///         a transfer; Vault is the only address ever allowed to
    ///         call this, enforced by `onlyVault`.
    function mint(address to, uint256 amount) external onlyVault {
        _mint(to, amount);
    }

    /// @notice Privileged burn, callable only by Vault, and — same as
    ///         mint — does not require the token owner's ERC20
    ///         allowance, since Vault's authority here comes from the
    ///         CDP relationship, not a transfer permission the user
    ///         granted.
    function burn(address from, uint256 amount) external onlyVault {
        _burn(from, amount);
    }
}
